import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { SemVer } from 'semver';
import * as util from './util';
import * as xpath from './xpath-extra';
import AdmZip = require('adm-zip');

export class NuGetPackageSource {
    readonly name: string;
    readonly url: string;
    readonly allowUpdate: boolean;

    public constructor(name: string, url: string, allowUpdate: boolean = false) {
        if (!name) {
            throw Error("The name of the package source must be specified.");
        }

        if (!url) {
            throw Error("The url for the package source must be specified.");
        }

        this.name = name;
        this.url = url;
        this.allowUpdate = allowUpdate;
    }
}

export class LocalNuGetPackage {
    readonly id: string;
    readonly version: NuGetVersion;
    readonly path: string;
    readonly relativePath: string;

    private static readonly nuspecIdSelector = xpath.parse('//package/metadata/id');
    private static readonly nuspecVersionSelector = xpath.parse('//package/metadata/version');

    public constructor(packagePath: string) {
        this.relativePath = path.relative(process.cwd(), packagePath);

        if (!fs.existsSync(packagePath)) {
            throw Error(`Local NuGet package '${this.relativePath}' does not exist.`);
        }

        this.path = packagePath;

        const nupkg = new AdmZip(packagePath);
        let nuspec: AdmZip.IZipEntry | null = null;
        for (const entry of nupkg.getEntries()) {
            if (entry.name == entry.entryName && entry.name.endsWith('.nuspec') && !entry.isDirectory) {
                nuspec = entry;
                break;
            }
        }

        if (!nuspec) {
            throw Error(`NuGet package '${this.relativePath}' does not contain a nuspec.`);
        }

        const nuspecXmlContent = nupkg.readAsText(nuspec);
        const nuspecXml = util.parseXml(nuspecXmlContent);

        this.id = xpath.select1Element(LocalNuGetPackage.nuspecIdSelector, nuspecXml)?.textContent!;
        const versionString = xpath.select1Element(LocalNuGetPackage.nuspecVersionSelector, nuspecXml)?.textContent;

        if (!this.id) {
            throw Error(`NuGet package '${this.relativePath}' nuspec does not contain a package ID.`);
        } else if (!this.id.match(/^[A-Za-z0-9_\-\.]+$/)) {
            throw Error(`NuGet package '${this.relativePath}' has an invalid package ID '${this.id}'.`);
        }

        if (!versionString) {
            throw Error(`NuGet package '${this.relativePath}' nuspec does not contain a package version.`);
        }

        this.version = parseNuGetVersion(versionString)!;
        if (!this.version) {
            throw Error(`NuGet package '${this.relativePath}' nuspec has an invalid version '${versionString}'`);
        }
    }
}

export class LegacyNuGetVersion {
    public readonly raw: string;
    public readonly semverPart: SemVer
    public readonly revision: number;

    private _version: string;
    public get version(): string {
        return this._version;
    }

    public get major(): number { return this.semverPart.major; }
    public get minor(): number { return this.semverPart.minor; }
    public get patch(): number { return this.semverPart.patch; }
    public get build(): readonly string[] { return this.semverPart.build; }
    public get prerelease(): ReadonlyArray<string | number> { return this.semverPart.prerelease; }

    public constructor(raw: string, semverPart: SemVer, revision: number) {
        // Legacy versions must have a revision or 1 or more
        // (Trying to make a package like 1.2.3.0 will just make 1.2.3)
        // https://github.com/NuGet/NuGet.Client/blob/e4e3b79701686199bc804a06533d2df054924d7e/src/NuGet.Core/NuGet.Versioning/NuGetVersion.cs#L180
        if (revision <= 0) {
            throw Error("Legacy NuGet versions must have a revision greater than 0.");
        }

        this.raw = raw;
        this.semverPart = semverPart;
        this.revision = revision;
        this._version = this.format();
    }

    public format(): string {
        let result = `${this.major}.${this.minor}.${this.patch}.${this.revision}`;

        if (this.prerelease.length > 0) {
            result += `-${this.prerelease.join('.')}`;
        }

        return this._version = result;
    }

    public toString(): string {
        return this.version;
    }
}

export type NuGetVersion = LegacyNuGetVersion | SemVer;

export function isLegacyVersion(version: NuGetVersion): version is LegacyNuGetVersion {
    const revision = (<LegacyNuGetVersion>version).revision;
    return typeof revision === 'number' && revision > 0;
}

export function isSemVer(version: NuGetVersion): version is SemVer {
    return !isLegacyVersion(version);
}

export function parseNuGetVersion(version: string): NuGetVersion | null {
    // First try parsing as a semver
    let semverResult = semver.parse(version);
    if (semverResult) {
        return semverResult;
    }

    // Try reading the string as a legacy NuGet version
    let match = version.match(/^(?<prefix>\d+\.\d+\.\d+)\.(?<revision>\d+)(?<suffix>.*)$/);
    if (match === null) {
        return null;
    }

    semverResult = semver.parse(`${match.groups!.prefix}${match.groups!.suffix}`);
    if (semverResult === null) {
        return null;
    }

    const revision = Number(match.groups!.revision);
    if (revision > 0) {
        return new LegacyNuGetVersion(version, semverResult, revision);
    } else {
        return semverResult;
    }
}
