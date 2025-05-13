import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as toolCache from '@actions/tool-cache';
import { Node as XmlNode } from '@xmldom/xmldom';
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { SemVer } from 'semver';
import * as modificationLog from './modification-log';
import { LocalNuGetPackage, NuGetPackageSource } from './nuget';
import * as util from './util';
import * as xpath from './xpath-extra';
import AdmZip = require('adm-zip');

export class BonsaiEnvironment {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly bonsaiConfigPath: string;
    readonly nugetConfigPath: string;
    readonly packagesPath: string;
    readonly bonsaiVersion: SemVer;

    private static readonly packageVersionSelector = xpath.parse('//PackageConfiguration/Packages/Package[@id=$packageId]/@version');

    public constructor(rootPath: string) {
        this.rootPath = rootPath;
        this.relativePath = path.relative(process.cwd(), rootPath);

        this.bonsaiConfigPath = path.join(rootPath, 'Bonsai.config');
        const relativeBonsaiConfigPath = path.relative(process.cwd(), this.bonsaiConfigPath);
        if (!fs.existsSync(this.bonsaiConfigPath)) {
            throw Error(`'${relativeBonsaiConfigPath}' is missing.`)
        }

        this.nugetConfigPath = path.join(rootPath, 'NuGet.config');
        const relativeNuGetConfigPath = path.relative(process.cwd(), this.nugetConfigPath);
        if (!fs.existsSync(this.nugetConfigPath)) {
            throw Error(`'${relativeNuGetConfigPath}' is missing.`);
        }

        this.packagesPath = path.join(rootPath, 'Packages');

        // Determine the desired Bonsai version from the Bonsai.config
        const bonsaiConfigContent = fs.readFileSync(this.bonsaiConfigPath, 'utf8');
        const bonsaiConfig = util.parseXml(bonsaiConfigContent);
        const bonsaiVerisonText = xpath.select1Attribute(BonsaiEnvironment.packageVersionSelector, bonsaiConfig, { variables: { packageId: 'Bonsai' } });

        if (!bonsaiVerisonText) {
            // Unlike Install.ps1 we don't fall back onto using the latest version for reproducibility reasons since this code is used for CI.
            throw Error(`Could not determine desired Bonsai version from '${relativeBonsaiConfigPath}'`);
        }

        this.bonsaiVersion = semver.parse(bonsaiVerisonText.nodeValue)!;
        if (!this.bonsaiVersion) {
            throw Error(`'${relativeBonsaiConfigPath}' specifies an invalid version string '${bonsaiVerisonText.nodeValue}' for Bonsai.`);
        }
    }

    private static readonly packageSourcesSelector = xpath.parse('//configuration/packageSources');
    private static readonly packageSourcesIndentSelector = xpath.parse('//configuration/packageSources/text()');
    private static readonly lastClearSourceSelector = xpath.parse('//configuration/packageSources/clear[last()]');

    public addPackageSources(sources: NuGetPackageSource[]): void {
        if (sources.length < 1) {
            throw Error("Expected one or more sources.");
        }

        const nugetConfigPathRelative = path.relative(process.cwd(), this.nugetConfigPath);
        using _ = new util.ScopedGroup(`Adding sources to '${this.nugetConfigPath}'...`);
        assert(fs.existsSync(this.nugetConfigPath), `'${nugetConfigPathRelative}' is expected to exist.`); // This will have been checked during the constructor

        modificationLog.logFileModificationIntent(this.nugetConfigPath);
        const nugetConfigContent = fs.readFileSync(this.nugetConfigPath, 'utf8');
        const nugetConfig = util.parseXml(nugetConfigContent);

        // Get the <packageSources> node
        // Note that we don't need to worry about there being more than one, NuGet only uses the first one.
        const packageSourcesNode = xpath.select1Element(BonsaiEnvironment.packageSourcesSelector, nugetConfig);
        if (!packageSourcesNode) {
            throw new Error(`'${nugetConfigPathRelative}' does not contain a <packageSources> element.`);
        }

        // Determine indentation to use for added source nodes
        const referenceIndentation = xpath.select1Text(BonsaiEnvironment.packageSourcesIndentSelector, nugetConfig) ?? nugetConfig.createTextNode('\n    ');

        // Determine where we will insert the added sources
        // TL;DR: We want them to appear at the top of the list
        //==============================================================================================================================================================
        // NuGet package restore behavior when multiple sources are present is not well documented (and the documentation which exists is inconsistent.)
        // Bonsai explicitly scans each source from first to last in each NuGet.config, starting with the NuGet.config closest to Bonsai.exe
        // https://github.com/bonsai-rx/bonsai/blob/44253e33b5d521fd8ea0fddc26f7836cf6f15aef/Bonsai.NuGet/PackageManager.cs#L303
        //
        // If Bonsai is ever upgraded to use the central NuGet package cache, it's likely this logic will change. In more modern corners of the official NuGet
        // client code, this is implemented in NuGet.PackageManagement.ResolverGather, particularly in the GatherAsync method.
        // https://github.com/NuGet/NuGet.Client/blob/e4e3b79701686199bc804a06533d2df054924d7e/src/NuGet.Core/NuGet.PackageManagement/Resolution/ResolverGather.cs#L83
        // The behavior of Bonsai sholud be retained (if this implementation is used), but it will start scanning each package source concurrently and
        // merge the results of each, which is not ideal for our purposes.
        //
        // However, this change should hopefully mean we'd get package source mapping support. So ideally if that change ever happens we should instead
        // install our sources in the machine-wide NuGet.config and use package source mapping to force all of our cached packages to come from it.
        // (That'd only be possible with a full cache hit though since source mapping can't map specific versions.)
        //
        // Note that we also need to be aware of any <clear /> entries. Namely we want to appear just after the final clear entry.
        // (There should only be one, and when it is present it's almost always the first entry. However neither are hard requirements.)
        //
        // In short, that is why we insert the new package sources at the top of the list. It ensures Bonsai prefers using our local cache.
        //==============================================================================================================================================================
        let insertionPoint: XmlNode | null; // null indicates that they will be inserted at the end

        const lastClear = xpath.select1Element(BonsaiEnvironment.lastClearSourceSelector, nugetConfig);
        if (lastClear) {
            insertionPoint = lastClear.nextSibling;

            if (insertionPoint) {
                assert(insertionPoint.parentElement == packageSourcesNode, 'Insertion point should be a child of <packageSources>.');
            } else {
                assert(packageSourcesNode.lastChild === lastClear, "If we don't have an explicit insertion point it's expected that the <clear /> must've been the final node.");
            }
        } else {
            insertionPoint = packageSourcesNode.firstChild;
        }

        // Add sources to the configuration
        const newSources = new Map<string, NuGetPackageSource>();
        for (const source of sources) {
            if (newSources.has(source.name)) {
                throw Error(`Provided package source list has more than one source named '${source.name}'`);
            }
            newSources.set(source.name, source);

            const newSource = nugetConfig.createElement('add');
            newSource.setAttribute('key', source.name);
            newSource.setAttribute('value', source.url);
            packageSourcesNode.insertBefore(newSource, insertionPoint);
            packageSourcesNode.insertBefore(referenceIndentation.cloneNode(), newSource);
            core.info(`Added package source source '${source.name}': '${source.url}'`);
        }

        // Remove sources that were replaced by any added ones
        for (let node = insertionPoint; node != null; node = node.nextSibling) {
            if (node.nodeType != XmlNode.ELEMENT_NODE) {
                continue;
            }

            if (node.nodeName != 'add') {
                throw Error(`Package sources contains unexpected node <${node.nodeName}> at ${nugetConfigPathRelative}:${node.lineNumber}`);
            }

            const name = xpath.select1Attribute('@key', node)?.nodeValue;
            if (!name) {
                throw Error(`Failed to get name of package source at ${nugetConfigPathRelative}:${node.lineNumber}, is the configuration valid?`);
            }

            const newSource = newSources.get(name);
            if (newSource) {
                const url = xpath.select1Attribute('@value', node)?.nodeValue;
                if (!newSource.allowUpdate) {
                    throw Error(`New source '${newSource.name}': '${newSource.url}' will replace an older source pointing to '${url}', but updates aren't enabled for it.`);
                }

                // Comment out the old source to disable it
                core.info(`Removing replaced package source '${name}': '${url}'.`);
                const commentedNode = nugetConfig.createComment(` ${util.xmlToString(node)} `);
                packageSourcesNode.replaceChild(commentedNode, node);
                node = commentedNode;
            }
        }

        // Write out the updated configuration
        const newConfig = util.xmlToString(nugetConfig);
        fs.writeFileSync(this.nugetConfigPath, newConfig);

        core.info('Final updated config:');
        core.info(newConfig.trim());
    }

    private static async acquirePortableZip(version: SemVer): Promise<string> {
        const zipFileName = `Bonsai.${version}.zip`;
        const zipLocation = util.getCachedPath(zipFileName);

        // Bonsai has already been downloaded
        if (fs.existsSync(zipLocation)) {
            core.debug(`Using Bonsai ${version} from action cache.`);
            return zipLocation;
        }

        // Check if it's already in the tool cache, otherwise we download a fresh copy
        const toolCacheKey: [string, string, string] = ['bonsai', version.toString(), 'AnyCpu'];
        let cachedLocation = toolCache.find(...toolCacheKey);

        if (cachedLocation) {
            console.info(`Using Bonsai ${version} from runner tool cache.`);
        } else {
            const url = `https://github.com/bonsai-rx/bonsai/releases/download/${version}/Bonsai.zip`;
            core.info(`Downloadig Bonsai ${version} from ${url}`);
            const downloaded = await toolCache.downloadTool(url);
            cachedLocation = await toolCache.cacheFile(downloaded, zipFileName, ...toolCacheKey);
            fs.unlinkSync(downloaded);
        }

        if (!cachedLocation) {
            throw Error(`Failed to locate or download Bonsai ${version}`);
        }

        fs.copyFileSync(path.join(cachedLocation, zipFileName), zipLocation);
        return zipLocation;
    }

    public async installBonsai(): Promise<void> {
        const zipPath = await BonsaiEnvironment.acquirePortableZip(this.bonsaiVersion);
        const zip = new AdmZip(zipPath);

        // We could just extract Bonsai.exe, but we extract everything except for Bonsai32.exe and NuGet.config to better match the logic used in Setup.ps1
        // (This does not actually remove anything from the original zip, it just manipulates the in-memory file entry table.)
        //TODO: @types/adm-zip is missing this function, should submit a PR
        (zip as any).deleteEntry('Bonsai32.exe');
        (zip as any).deleteEntry('NuGet.config');

        // Additionally, we remove the Packages directory if it exists.
        // (It doesn't in current portable zips, but if it were added it'd cause problems for us.)
        (zip as any).deleteEntry('Packages');

        core.debug(`Installing Bonsai ${this.bonsaiVersion} to '${this.relativePath}'...`);
        zip.extractAllTo(this.rootPath, true);
        core.info(`Bonsai ${this.bonsaiVersion} installed to '${this.relativePath}'`);
    }

    public async bootstrap(forceDependencyWalk?: boolean): Promise<boolean> {
        if (forceDependencyWalk) {
            return this.bootstrapWithForcedDependencyWalk();
        }

        let command = './Bonsai.exe';
        let args = ['--no-editor'];

        if (process.platform != 'win32') {
            args.unshift(command);
            command = 'mono';
        }

        let errorCode: number;
        {
            using _ = new util.ScopedGroup(`Bootstrapping Bonsai environment '${this.relativePath}'...`);
            core.debug(`Running command '${command} ${args.join(' ')}' in '${this.rootPath}'`);
            errorCode = await exec.exec(command, args, {
                cwd: this.rootPath,
                ignoreReturnCode: true,
            });
        }

        if (errorCode !== 0) {
            core.error(`Failed to bootstrap '${this.relativePath}', Bonsai exited with error ${errorCode}.`);
        }

        return errorCode === 0;
    }

    private async bootstrapWithForcedDependencyWalk(): Promise<boolean> {
        if (this.bonsaiVersion.compare('2.6.2') < 0) {
            core.error(`Cannot force a dependency walk of Bonsai ${this.bonsaiVersion}, which is required for restoring after injecting packages.`);
            return false;
        }

        let command = path.join(__dirname, 'BonsaiPackageInstallHelper.exe');
        let args = [path.join(this.rootPath, 'Bonsai.exe')];

        if (process.platform != 'win32') {
            args.unshift(command);
            command = 'mono';
        }

        let errorCode: number;
        {
            using _ = new util.ScopedGroup(`Bootstrapping Bonsai environment '${this.relativePath}' with forced dependency walk...`);
            core.debug(`Running command '${command} ${args.join(' ')}' in '${this.rootPath}'`);
            errorCode = await exec.exec(command, args, {
                cwd: this.rootPath,
                ignoreReturnCode: true,
            });
        }

        if (errorCode !== 0) {
            core.error(`Failed to bootstrap '${this.relativePath}', Bonsai exited with error ${errorCode}.`);
        }

        return errorCode === 0;
    }

    public async capturePackages(destinationPath: string): Promise<void> {
        const packagePaths = await glob.create(
            path.join(util.globEscape(this.packagesPath), '**', '*.nupkg'),
            {
                matchDirectories: false,
                implicitDescendants: false,
            }
        );

        using _ = new util.ScopedGroup(`Collecting restored packages from '${this.relativePath}' into the local package cache...`);
        let total = 0;
        let captured = 0;
        for await (const packagePath of packagePaths.globGenerator()) {
            const relativePackagePath = path.relative(process.cwd(), packagePath);
            const cachedPath = path.join(destinationPath, path.basename(packagePath));
            total++;
            if (fs.existsSync(cachedPath)) {
                core.debug(`Not capturing '${relativePackagePath}', package is already in cache.`);

                // Make sure the cached package and the actual package are truely identical
                // This is pretty heavy and probably indicates a bug with either Bonsai or setup-bonsai, so don't do this unless the workflow is being debugged
                if (core.isDebug()) {
                    const packageHash = await util.hashFile(packagePath);
                    const cachedHash = await util.hashFile(cachedPath);
                    if (packageHash != cachedHash) {
                        core.warning(`'${relativePackagePath}' has hash ${packageHash}, which is different from the cached package (${cachedHash})!`);
                    }
                }
            } else {
                captured++;
                fs.copyFileSync(packagePath, cachedPath);
                core.info(`Saved '${relativePackagePath}' to the workflow package cache.`);
            }
        }

        core.info(`Captured ${captured}/${total} packages`);
    }

    private static readonly packageSelector = xpath.parse('//PackageConfiguration/Packages/Package[@id=$packageId]');
    private static readonly bonsaiConfigPackagesSelector = xpath.parse('//PackageConfiguration/Packages');
    private static readonly bonsaiConfigPackagesIndentSelector = xpath.parse('//PackageConfiguration/Packages/text()');
    private static readonly assemblyLocationsByPackageLocationSelector = xpath.parse(
        '//PackageConfiguration/AssemblyLocations/AssemblyLocation[starts-with(translate(@location, "\\", "/"), $packageLocation)]'
    );
    private static readonly libraryFolderByPackageLocationSelector = xpath.parse(
        '//PackageConfiguration/LibraryFolders/LibraryFolder[starts-with(translate(@path, "\\", "/"), $packageLocation)]'
    );
    private static readonly assemblyReferencesByNameSelector = xpath.parse(
        '//PackageConfiguration/AssemblyReferences/AssemblyReference[@assemblyName=$assemblyName]'
    );

    public async injectPackages(nugetPackages: Iterable<LocalNuGetPackage>): Promise<void> {
        const bonsaiConfigPathRelative = path.relative(process.cwd(), this.bonsaiConfigPath);
        using _ = new util.ScopedGroup(`Adding packages to '${bonsaiConfigPathRelative}'...`);
        assert(fs.existsSync(this.bonsaiConfigPath), `'${bonsaiConfigPathRelative}' is expected to exist.`); // This will have been checked during the constructor

        modificationLog.logFileModificationIntent(this.bonsaiConfigPath);
        const bonsaiConfigContent = fs.readFileSync(this.bonsaiConfigPath, 'utf8');
        const bonsaiConfig = util.parseXml(bonsaiConfigContent);

        // Get the <Packages> node
        // Unlike with NuGet.config, Bonsai actually does use redundant <Packages> sections if there's more than once
        // However this file is regularly normalized by Bonsai, and will have been normalized when Bonsai restored the environment before we reached this point
        // As such we won't worry about there being more than one.
        const packagesNode = xpath.select1Element(BonsaiEnvironment.bonsaiConfigPackagesSelector, bonsaiConfig);
        if (!packagesNode) {
            throw new Error(`'${bonsaiConfigPathRelative}' does not contain a <Packages> element.`);
        }

        // Determine indentation to use for added source nodes
        const referenceIndentation = xpath.select1Text(BonsaiEnvironment.bonsaiConfigPackagesIndentSelector, bonsaiConfig) ?? bonsaiConfig.createTextNode('\n    ');

        // Determine where to place completely new package nodes
        // The final child node is actually the whitespace for the end tag, so we want to be before it
        let insertionPoint: XmlNode | null = packagesNode.lastChild;
        if (insertionPoint?.nodeType != XmlNode.TEXT_NODE) {
            insertionPoint = null; // Insert at very end
        }

        // Inject the packages
        for (const nugetPackage of nugetPackages) {
            // Create the new package entry
            const injectedNode = bonsaiConfig.createElement('Package');
            injectedNode.setAttribute('id', nugetPackage.id);
            injectedNode.setAttribute('version', nugetPackage.version.toString());

            let replaceNode = xpath.select1Element(BonsaiEnvironment.packageSelector, bonsaiConfig, { variables: { packageId: nugetPackage.id } });
            if (replaceNode) {
                const replaceId = xpath.select1Attribute('@id', replaceNode)?.nodeValue;
                const replaceVersion = xpath.select1Attribute('@version', replaceNode)?.nodeValue;

                assert(replaceId);
                assert(replaceVersion);
                assert(nugetPackage.id.toUpperCase() == replaceId.toUpperCase());

                // Remove the restored package from Bonsai's Packages directory in order to ensure it gets restored again
                // (Only actually necessary if the versions match, but better safe than sorry.)
                const replacePackagePath = path.join(this.packagesPath, `${replaceId}.${replaceVersion ?? 'ERROR'}`);
                const replacePackagePathRelative = path.relative(process.cwd(), replacePackagePath);
                const replacePackagePathLocal = path.relative(this.rootPath, replacePackagePath).replaceAll('\\', '/') + '/';

                if (fs.existsSync(replacePackagePath)) {
                    core.info(`Removing replaced package's contents '${replacePackagePathRelative}'`);
                    fs.rmSync(replacePackagePath, { recursive: true });
                } else {
                    core.warning(`Want to remove replaced package's contents '${replacePackagePathRelative}', but they don't actually exist!`);
                }

                // Replace the node
                packagesNode.replaceChild(injectedNode, replaceNode);

                // Find assemblies related to the removed package via their associated <AssemblyLocation> nodes (which we will also remove)
                // This might seem unecessary if you experiment with your Bonsai.config, but occasionally for whatever reason it makes Bonsai blow up to leave these around:
                // System.InvalidOperationException:
                //   The assembly reference '(Assembly.Name, MSIL)' has already been assigned to a different location. Consider uninstalling the conflicting package.
                core.debug(`Checking for <AssemblyLocation>s with a location starting with '${replacePackagePathLocal}'`);
                const relatedAssemblyLocations = xpath.selectElements(
                    BonsaiEnvironment.assemblyLocationsByPackageLocationSelector,
                    bonsaiConfig,
                    { variables: { packageLocation: replacePackagePathLocal } }
                );

                for (const relatedAssemblyLocation of relatedAssemblyLocations) {
                    const assemblyName = xpath.select1Attribute('@assemblyName', relatedAssemblyLocation)?.nodeValue;
                    let displayAssemblyName = assemblyName ?? '<error-assembly>';
                    if (!assemblyName) {
                        core.warning(`Failed to get assemblyName for <AssemblyLocation> at ${bonsaiConfigPathRelative}:${relatedAssemblyLocation.lineNumber}`);
                    }

                    core.info(`Removing associated location for assembly '${displayAssemblyName}' at ${bonsaiConfigPathRelative}:${relatedAssemblyLocation.lineNumber}`);
                    xpath.smartRemove(relatedAssemblyLocation);

                    if (assemblyName) {
                        const assemblyReferences = xpath.selectElements(
                            BonsaiEnvironment.assemblyReferencesByNameSelector,
                            bonsaiConfig,
                            { variables: { assemblyName: assemblyName } }
                        );

                        for (const assemblyReference of assemblyReferences) {
                            core.info(`Removing associated assembly reference at ${bonsaiConfigPathRelative}:${assemblyReference.lineNumber}`);
                            xpath.smartRemove(assemblyReference);
                        }
                    }
                }

                // Find library folders related to the removed package
                const relatedLibraryFolders = xpath.selectElements(
                    BonsaiEnvironment.libraryFolderByPackageLocationSelector,
                    bonsaiConfig,
                    { variables: { packageLocation: replacePackagePathLocal } }
                );

                for (const relatedLibraryFolder of relatedLibraryFolders) {
                    core.info(`Removing associated library folder at ${bonsaiConfigPathRelative}:${relatedLibraryFolder.lineNumber}`);
                    xpath.smartRemove(relatedLibraryFolder);
                }
            } else {
                packagesNode.insertBefore(injectedNode, insertionPoint);
                packagesNode.insertBefore(referenceIndentation.cloneNode(), injectedNode);
            }
        }

        // Write out the updated configuration
        const newConfig = util.xmlToString(bonsaiConfig);
        fs.writeFileSync(this.bonsaiConfigPath, newConfig);

        core.info('Final updated config:');
        core.info(newConfig.trim());
    }
}
