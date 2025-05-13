import * as core from '@actions/core';
import { CacheState, SetupBonsaiCache } from './cache';
import * as util from './util';

async function main(): Promise<void> {
    core.debug(`Starting post action for invocation ${util.invocationId}`);

    if (!util.inputs.enableCache) {
        core.debug("Cache is disabled, nothing to do.");
        return;
    }

    const cache = SetupBonsaiCache.createForUpload();

    if (cache.state == CacheState.Full) {
        core.info(`Exact cache hit ocurred on the primary key, not saving cache.`);
        return;
    }

    const cacheId = await cache.uploadCache();
    if (cacheId != -1) {
        core.info(`Cache successfully saved with key '${cache.primaryKey}'`);
    }
}

main();
