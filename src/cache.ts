import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BonsaiEnvironment } from './bonsai';
import * as util from './util';
import { State } from './util';

export enum CacheState {
    NoHit = 'none',
    Partial = 'partial',
    Full = 'full',
}

export class SetupBonsaiCache {
    readonly primaryKey: string;
    private readonly restoreKeys: string[];

    readonly cachePath: string;
    readonly packageCacheRoot: string;
    private readonly stagedCacheFilePath: string;
    private readonly actualCacheFilePath: string;

    private _restoredFrom: string | null = null;
    public get restoredFrom(): string | null {
        return this._restoredFrom;
    }
    private set restoredFrom(value: string | null) {
        this._restoredFrom = value;
    }

    public get state(): CacheState {
        if (this.primaryKey == this.restoredFrom) {
            return CacheState.Full;
        } else if (this.restoredFrom) {
            return CacheState.Partial;
        } else {
            return CacheState.NoHit;
        }
    }

    public get isEnabled(): boolean {
        return util.inputs.enableCache;
    }

    private _isIncomplete: boolean | null = null;
    public get isIncomplete(): boolean {
        if (this._isIncomplete === null) {
            this._isIncomplete = core.getState(State.CacheIsIncomplete) === 'true';
        }

        return this._isIncomplete;
    }

    public set isIncomplete(value: boolean) {
        core.saveState(State.CacheIsIncomplete, (this._isIncomplete = value).toString());
    }

    private constructor(primaryKey: string, restoreKeys: string[], restoredFromKey: string | null) {
        this.primaryKey = primaryKey;
        this.restoreKeys = [...restoreKeys, `${primaryKey}-incomplete`];
        this.restoredFrom = restoredFromKey;

        // Because we save everything in folder associated with our invocation ID and @actions/cache wants to cache based on absolute file paths,
        // we work with out cache in a invocation-specific (staged) location, but move it to a more generic (actual) location when @actions/cache needs to touch it.
        // Additionally, we don't let @actions/cache handle gathering the individual files due to the above, but also we need to capture the state of the package folders
        // *before* we modify them for injecting packages.
        this.cachePath = util.getCachedPath();
        this.packageCacheRoot = util.getCachedPath('package-cache');
        this.stagedCacheFilePath = util.getCachedPath('..', 'cache.tar');
        this.actualCacheFilePath = util.getTemporaryPath('cache.tar');

        fs.mkdirSync(this.cachePath, { recursive: true });
        fs.mkdirSync(this.packageCacheRoot, { recursive: true });
    }

    public static createForRestore(environments: BonsaiEnvironment[]): SetupBonsaiCache {
        // Build cache key
        // Note that it is not necessary to handle the difference operating systems having different temporary directories, the actions cache infrastructure already handles that:
        // https://github.com/actions/cache#cache-version
        // It's not fatal if two concurrent jobs in a matrix end up having the same primary key and cache version key, one will simply quietly fail to reserve a key and skip the upload.
        // A message is printed, but it's not marked as a warning or error or anything that might cause annoyance.
        let primaryKey = "setup-bonsai-";

        if (util.inputs.cacheKeyPrefix) {
            primaryKey += `${util.inputs.cacheKeyPrefix}-`;
        }

        const restoreKeys = [primaryKey];

        const hash = crypto.createHash('sha256');
        for (const environment of environments) {
            hash.update(environment.relativePath);
            hash.update(fs.readFileSync(environment.bonsaiConfigPath));
            hash.update(fs.readFileSync(environment.nugetConfigPath));
        }
        primaryKey += hash.digest('hex');

        core.saveState(State.CachePrimaryKey, primaryKey);
        return new SetupBonsaiCache(primaryKey, restoreKeys, null);
    }

    public static createForUpload(): SetupBonsaiCache {
        const primaryKey = core.getState(State.CachePrimaryKey);
        if (!primaryKey) {
            throw Error("Primary key is unavailable, cannot save cache.");
        }

        const restoredFromKey = core.getState(State.CacheRestoredFrom);

        return new SetupBonsaiCache(primaryKey, [], restoredFromKey);
    }

    public async restore(): Promise<void> {
        if (!this.isEnabled) {
            core.debug(`Skipping cache restore of ${this.primaryKey} as caching is not enabled.`);
            return;
        }

        // Don't do anything if we're running locally
        if (util.actionIsUnderTest && !cache.isFeatureAvailable()) {
            core.warning(`Ignoring restore of ${this.primaryKey}, the cache service is not configured.`);
            return;
        }

        let restoredFrom;
        {
            using _ = new util.ScopedGroup("Restoring cache...");
            restoredFrom = await cache.restoreCache([this.actualCacheFilePath], this.primaryKey, this.restoreKeys);
        }

        if (restoredFrom) {
            {
                using _ = new util.ScopedGroup(`Extracting restored cache from ${restoredFrom}...`);
                const workingDirectory = path.dirname(this.stagedCacheFilePath);
                const args = [ '-xf', this.actualCacheFilePath ];

                if (core.isDebug()) {
                    args.unshift('--verbose');
                }

                core.debug(`Command will be run from '${workingDirectory}'`);
                const errorCode = await exec.exec('tar', args, {
                    cwd: workingDirectory,
                    ignoreReturnCode: true,
                });

                if (errorCode !== 0) {
                    core.warning(`Failed to extract the restored cache, it was not used.`);
                    restoredFrom = undefined;
                } else {
                    this.restoredFrom = restoredFrom;
                    core.saveState(State.CacheRestoredFrom, restoredFrom);
                }
            }

            await util.uploadDebugArtifact(
                `CacheDebug.Restored.${restoredFrom}`,
                'restored cache',
                [this.actualCacheFilePath],
                path.dirname(this.actualCacheFilePath)
            );
        }
    }

    public async captureCache(): Promise<void> {
        if (!this.isEnabled) {
            core.debug("Skipping cache capture as caching is not enabled.");
            return;
        }

        if (this.state == CacheState.Full) {
            if (core.isDebug()) {
                core.debug("Would typically skip the cache capture here as we had an exact cache hit, but capturing it anyway for debugging purposes.");
            } else {
                core.debug("Skipping cache capture as since we had an exact cache hit.");
                return;
            }
        }

        {
            using _ = new util.ScopedGroup("Capturing cache tarball...");
            const workingDirectory = path.dirname(this.stagedCacheFilePath);
            const args = [
                '--posix',
                '-cf',
                path.basename(this.stagedCacheFilePath),
                path.relative(workingDirectory, this.cachePath),
            ];

            if (core.isDebug()) {
                args.unshift('--verbose');
            }

            core.debug(`Command will be run from '${workingDirectory}'`);
            const errorCode = await exec.exec('tar', args, {
                cwd: workingDirectory,
                ignoreReturnCode: true,
            });

            if (errorCode !== 0) {
                throw Error(`Failed to capture cache, tar exited with error ${errorCode}.`);
            }
        }

        await util.uploadDebugArtifact(
            `CacheDebug.${this.primaryKey}`,
            'cache',
            [this.stagedCacheFilePath],
            path.dirname(this.stagedCacheFilePath)
        );
    }

    public async uploadCache(): Promise<number> {
        if (!this.isEnabled) {
            core.debug(`Skipping cache save of ${this.primaryKey} as caching is not enabled.`);
            return -1;
        }

        if (!fs.existsSync(this.stagedCacheFilePath)) {
            throw Error(`Staged cache file does not exist at '${this.stagedCacheFilePath}', cannot upload cache!`);
        }

        // The GitHub Actions caching infrastructure is sensitive to absolute file paths, so we don't want to cache our archive
        // when it's inside our invocation-specific temporary folder, hence this move.
        fs.renameSync(this.stagedCacheFilePath, this.actualCacheFilePath);

        // Don't do anything if we're running locally without caching capabilities
        if (util.actionIsUnderTest && !cache.isFeatureAvailable()) {
            core.warning(`Ignoring cache save of ${this.primaryKey}, the cache service is not configured.`);
            return -1;
        }

        let saveKey = this.primaryKey;

        if (this.isIncomplete) {
            saveKey += '-incomplete';
        }

        using _ = new util.ScopedGroup("Saving cache...");
        return await cache.saveCache([this.actualCacheFilePath], saveKey);
    }
}
