import * as core from '@actions/core';
import * as glob from '@actions/glob';
import * as io from '@actions/io';
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BonsaiEnvironment } from './bonsai';
import { CacheState, SetupBonsaiCache } from './cache';
import * as modificationLog from './modification-log';
import { LocalNuGetPackage, NuGetPackageSource } from './nuget';
import * as util from './util';
import { Outputs } from './util';

const inputs = util.inputs;

let suppressModificationLogArchival = false;

async function main(): Promise<void> {
    core.debug(`Starting action invocation ${util.invocationId}`);

    if (util.actionIsUnderTest) {
        core.warning("Action is in test mode!");

        if (process.argv.indexOf('--restore-modified') !== -1) {
            modificationLog.restoreModifiedFiles();
            core.info("Local changes have been reverted.");
            suppressModificationLogArchival = true;
            return;
        }
    } else if (fs.existsSync(util.getTemporaryPath())) {
        // We could overcome this limitation, but let's do it on an as-needed basis and just warn about the situations instead.
        // (We can't simply use the same shared directory because the cache key would not be correct.)
        // If you hit this, please create an issue describing your use-case!
        core.warning("setup-bonsai used more than once per job. Note that the package cache will *not* be shared between invocations.");
    }

    // Early detect if Mono will be needed but isn't available and print basic guidance
    if (process.platform != 'win32' && !(await io.which('mono', false))) {
        core.warning(
            `Mono could not be found, setup-bonsai will most likely fail once it reaches the bootstrapping stag.
            Mono is no longer installed on the latest GitHub-hosted runners. See https://github.com/bonsai-rx/setup-bonsai/issues/1 for details.`
        );
    }

    // Enumerate environments
    util.sectionHeading("Enumerate Bonsai environments");
    let environments: BonsaiEnvironment[] = [];
    {
        let hadErrors = false;
        core.debug(`Enumerating environments from patterns:\n${inputs.environmentPaths}`);
        const environmentPaths = await glob.create(inputs.environmentPaths, { implicitDescendants: false });
        for await (const environmentPath of environmentPaths.globGenerator()) {
            let relativePath = path.relative(process.cwd(), environmentPath);
            core.debug(`Checking '${relativePath}'...`);

            try {
                const environment = new BonsaiEnvironment(environmentPath);
                environments.push(environment);
                core.info(`Found Bonsai environment '${environment.relativePath}' using Bonsai ${environment.bonsaiVersion}`);

                const prereleaseStart = environment.bonsaiVersion.prerelease[0];
                if (typeof prereleaseStart === 'string' && prereleaseStart.match(/^ci\d+$/)) {
                    core.warning(`Bonsai ${environment.bonsaiVersion} appears to be an unstable CI build of Bonsai, which is not yet supported. See https://github.com/bonsai-rx/setup-bonsai/issues/7`);
                }
            } catch (error) {
                core.error(`Bonsai environment at '${relativePath}' is invalid: ${error}`);
                hadErrors = true;
            }
        }

        if (hadErrors) {
            core.setFailed("One or more Bonsai environments could not be loaded.");
            return;
        }
    }
    environments.sort((a, b) => util.stringCompare(a.relativePath, b.relativePath));

    if (environments.length == 0) {
        core.setFailed(`Failed to find any Bonsai environments matching these patterns:\n${inputs.environmentPaths}`);
        return;
    }

    // Enumerate packages to be injected
    let injectPackages = new Map<string, LocalNuGetPackage>();
    const injectedPackagesPath = util.getTemporaryPath(util.invocationId, 'injected-packages');

    if (fs.existsSync(injectedPackagesPath)) {
        // The injected packages path _must_ start empty or the Bonsai restores will might be affected by the injected packages prematurely and corrupt the cache
        if (util.actionIsUnderTest) {
            fs.rmSync(injectedPackagesPath, { recursive: true });
        } else {
            assert(false, `The injected packages directory '${injectedPackagesPath}' already exists!`);
        }
    }

    fs.mkdirSync(injectedPackagesPath, { recursive: true });

    if (inputs.injectPackages) {
        util.sectionHeading("Enumerate packages to inject");
        let haveErrors = false;
        core.debug(`Enumerating packages to inject from patterns:\n${inputs.injectPackages}`);
        const packagePaths = await glob.create(inputs.injectPackages, { implicitDescendants: false, matchDirectories: false });
        for await (const packagePath of packagePaths.globGenerator()) {
            let relativePath = path.relative(process.cwd(), packagePath);
            core.debug(`Checking '${packagePath}'...`);

            try {
                const nugetPackage = new LocalNuGetPackage(packagePath);
                core.info(`Loaded local NuGet package ${nugetPackage.id} version ${nugetPackage.version} from '${relativePath}'`);

                if (injectPackages.has(nugetPackage.id)) {
                    core.error(`NuGet package id ${nugetPackage.id} appears in the injection list more than once!\n(Injecting multiple versions of the same package is currently unsupported.)`);
                    haveErrors = true;
                } else {
                    injectPackages.set(nugetPackage.id, nugetPackage);
                }
            } catch (error) {
                core.error(error?.toString() ?? `Unknown error while checking '${packagePath}'`);
                haveErrors = true;
            }
        }

        if (haveErrors) {
            core.setFailed("One or more injected packages could not be loaded.");
            return;
        }
    }

    // Restore cache
    util.sectionHeading("Restore cache", !util.inputs.enableCache);
    let cache: SetupBonsaiCache = SetupBonsaiCache.createForRestore(environments);
    await cache.restore();
    core.setOutput(Outputs.CacheHit, cache.state);

    if (cache.state != CacheState.NoHit) {
        core.info(`Restored cached Bonsai packages from cache '${cache.restoredFrom}' (${cache.state == CacheState.Full ? "Perfect" : "Partial"} match)`);
    } else {
        core.info(`No cached Bonsai packages were able to be restored from the cache`);
    }

    // Install Bonsai
    util.sectionHeading("Install Bonsai to each environment");
    for (const environment of environments) {
        await environment.installBonsai();
    }

    // Install package sources
    util.sectionHeading("Inject local package sources");
    {
        let packageSources = [
            new NuGetPackageSource(`setup-bonsai cache ${util.invocationId}`, cache.packageCacheRoot),
        ];

        if (injectPackages.size > 0) {
            packageSources.unshift(new NuGetPackageSource(`setup-bonsai injected packages ${util.invocationId}`, injectedPackagesPath,));
        }

        core.info(`Injecting ${packageSources.length} package source${packageSources.length == 1 ? '' : 's'} into each environment`);
        for (const environment of environments) {
            environment.addPackageSources(packageSources);
        }
    }

    // Bootstrap Bonsai
    // util.sectionHeading("Bootstrap each Bonsai environment");
    // {
    //     let allSuccessful = true;
    //     for (const environment of environments) {
    //         allSuccessful &&= await environment.bootstrap();
    //         await environment.capturePackages(cache.packageCacheRoot);
    //     }

    //     if (!allSuccessful) {
    //         core.setFailed("Failed to restore one or more Bonsai environments.");
    //         return;
    //     }
    // }

    // Capture cache while it's still pristine (IE: before we inject unpredictable workflow-provided packages into it)
    // util.sectionHeading("Capture cache");
    // await cache?.captureCache();

    // Inject packages
    if (injectPackages.size == 0) {
        // If there are no packages to inject, we simply bootstrap without populating the injected packages repo
        util.sectionHeading("Bootstrapping Bonsai environment...");
        let allSuccessful = true;
        for (const environment of environments) {
            allSuccessful &&= await environment.bootstrap();
        }

        if (!allSuccessful) {
            core.setFailed("Failed to restore one or more Bonsai environments.");
            return;
        }
    } else {
        util.sectionHeading("Inject packages");

        // Populate the injected packages local package repo
        core.info("Populating local package repo...");
        assert(fs.readdirSync(injectedPackagesPath).length == 0, "The injected packages path should still be empty at this point.");
        for (const injectPackage of injectPackages.values()) {
            fs.copyFileSync(injectPackage.path, path.join(injectedPackagesPath, path.basename(injectPackage.path)));
        }

        // Inject the packages
        // for (const environment of environments) {
        //     await environment.injectPackages(injectPackages.values());
        // }

        // Restore all Bonsai environments again to install the injected packages
        core.info("Bootstrapping Bonsai environment..");
        let allSuccessful = true;
        for (const environment of environments) {
            allSuccessful &&= await environment.bootstrap();
        }

        if (!allSuccessful) {
            core.setFailed("Failed to restore one or more Bonsai environments.");
            return;
        }
    }
}

main().finally(async () => {
    // Capture the files we modified for debugging purposes
    if (core.isDebug() && !suppressModificationLogArchival) {
        await modificationLog.archiveModificationLog();
    }
});
