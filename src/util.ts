import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import { DOMParser, MIME_TYPE, Document as XmlDocument, Node as XmlNode, XMLSerializer } from '@xmldom/xmldom';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as stream from 'stream/promises';

// Node's default error printer is extremely obnoxious and tries to be "helpful" by printing the source line where the exception ocurred
// This is all well and good, but sometimes the source map lookup fails and it just barfs an extremely long minified source line which is
// not only useless but makes the log much more annoying to read. This behavior is implemented in `GetErrorSource` in `node_errors.cc` and
// seemingly cannot be disabled directly except by overriding the uncaught exception handler, so that's what we do. :/
process.on('uncaughtException', (err, origin) => {
    // We don't use core.error here as it causes the initialization order to get messed up and might not work as expected
    let message: string = err.stack ?? `${err.message}:\n(Stack trace missing)`;
    if (!actionIsUnderTest) {
        message = message
            .replaceAll('%', '%25')
            .replaceAll('\r', '%0D')
            .replaceAll('\n', '%0A')
        ;
    }
    process.stdout.write(`::error::${message}`);
    if (!process.exitCode) {
        process.exitCode = -1;
    }
});

export const actionIsUnderTest = !!process.env['__TEST_INVOCATION_ID'];

export const inputs = {
    environmentPaths: core.getInput('environment-paths', { required: true }),
    injectPackages: core.getInput('inject-packages'),
    enableCache: core.getBooleanInput('enable-cache', { required: true }),
    cacheKeyPrefix: core.getInput('cache-key-prefix'),
};

export enum State {
    ActionInvocationId = 'ActionInvocationId',
    CachePrimaryKey = 'CachePrimaryKey',
    CacheRestoredFrom = 'CacheRestoredFrom',
    CacheIsIncomplete = 'CacheIsIncomplete',
}

export enum Outputs {
    CacheHit = 'cache-hit',
}

export const invocationId = (() => {
    // This initializer will be evlauated before anything else so this is implicitly a good palce to do this
    if (actionIsUnderTest) {
        loadState();
    }

    let result = core.getState(State.ActionInvocationId);
    if (result) {
        return result;
    }

    result = process.env['__TEST_INVOCATION_ID'] || crypto.randomUUID();
    core.saveState(State.ActionInvocationId, result);
    return result;
})();

export function getTemporaryPath(...paths: string[]): string {
    let runnerTemp = process.env['RUNNER_TEMP'];
    if (!runnerTemp) {
        throw Error("RUNNER_TEMP is not specified!");
    }

    return path.join(runnerTemp, 'setup-bonsai', ...paths);
}

export function getCachedPath(...paths: string[]): string {
    return getTemporaryPath(invocationId, "cache", ...paths);
}

export function stringCompare(a: string, b: string): number {
    if (a < b) {
        return -1;
    } else if (a > b) {
        return 1;
    } else {
        return 0;
    }
}

export function parseXml(xml: string): XmlDocument {
    // xmldom does not tolerate the presence of a BOM so make sure we strip it off
    let hadBom = false;
    if (xml.charCodeAt(0) == 0xFEFF) {
        xml = xml.substring(1);
        hadBom = true;
    }

    const result = new DOMParser().parseFromString(xml, MIME_TYPE.XML_TEXT);

    // Preserve information about things which will be lost by xmldom so we can round-trip better
    const extra = result as any;
    extra.$___setupBonsaiHadBom = hadBom;
    extra.$___setupBonsaiEndsWithNewLine = xml.endsWith('\n');
    const eol = xml.match(/\r?\n/);
    extra.$___setupBonsaiLineEndings = eol ? eol[0] : os.EOL;

    return result;
}

export function xmlToString(xml: XmlNode): string {
    let result = new XMLSerializer().serializeToString(xml);

    // .NET's XML writing facilities like to add a space before the `/>` on self-closing tags, xmldom does not.
    // https://github.com/xmldom/xmldom/issues/465
    // Since XML doesn't allow > outside of the context of an element, we can safely use this hack to add the spaces back to avoid diff churn
    result = result.replaceAll('/>', ' />');

    // Preserve BOM and line endings from input file
    const extra = xml as any;
    if (extra.$___setupBonsaiHadBom) {
        result = '\u{FEFF}' + result;
    }

    if (extra.$___setupBonsaiEndsWithNewLine) {
        result += '\n';
    }

    if (extra.$___setupBonsaiLineEndings === '\r\n') {
        result = result.replaceAll('\n', '\r\n');
    }

    return result;
}

// Copied from https://github.com/actions/toolkit/blob/36db4d62adf0bf89f2ebae569f59279e55bcd67f/packages/glob/src/internal-pattern.ts#L189
export function globEscape(s: string): string {
    return (process.platform === 'win32' ? s : s.replace(/\\/g, '\\\\')) // escape '\' on Linux/macOS
        .replace(/(\[)(?=[^/]+\])/g, '[[]') // escape '[' when ']' follows within the path segment
        .replace(/\?/g, '[?]') // escape '?'
        .replace(/\*/g, '[*]') // escape '*'
}

export async function hashFile(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await stream.pipeline(
        fs.createReadStream(filePath),
        hash
    );
    return hash.digest('hex');
}

export async function uploadDebugArtifact(artifactName: string, humanName: string, filePaths: string[], commonRoot: string) {
    // Nothing to do when not debugging, and the artifacts service is not available for local tests
    if (!core.isDebug() || actionIsUnderTest) {
        return;
    }

    using _ = new ScopedGroup(`Uploading ${humanName} artifact for debugging purposes...`);
    const artifact = new DefaultArtifactClient();
    const artifactInfo = await artifact.uploadArtifact(
        `${invocationId}-${artifactName}`,
        filePaths,
        commonRoot,
        { retentionDays: 5 }
    );
    core.info(`Upload complete: ${artifactInfo.id} (bytes: ${artifactInfo.size})`);
}

const headingBorder = '='.repeat(120);
export function sectionHeading(title: string, quietCondition?: boolean) {
    if (quietCondition) {
        core.info(`========== ${title} ==========`);
        return;
    }

    core.info("");
    core.info(headingBorder);
    core.info(title);
    core.info(headingBorder);
}

export class ScopedGroup {
    static nesting: number = 0;
    constructor(name: string) {
        core.startGroup(name);
        if (ScopedGroup.nesting == 1) {
            // GitHub doesn't support nesting groups and the UI looks quite weird when you do it, so we should avoid it
            // https://github.com/actions/toolkit/issues/1001
            core.warning("Internal: Tried to create nested GitHub Actions log groups!");
        }
        ScopedGroup.nesting++;
    }

    [Symbol.dispose](): void {
        ScopedGroup.nesting--;
        core.endGroup();
    }
}

// Helper to simulate restoring saved GITHUB_STATE when testing this action locally
function loadState(): void {
    if (!actionIsUnderTest) {
        throw Error("This helper should only ever be used when testing locally!");
    }

    const stateFilePath = process.env['GITHUB_STATE'];

    if (!stateFilePath || !fs.existsSync(stateFilePath)) {
        core.warning('Could not locate GITHUB_STATE');
        return;
    }

    //TODO: This doesn't handle ActionInvocationId appropriately because it was implicitly already evaluated when this module was loaded
    // Note a huge deal since this function is only for testing and we use a fixed ID for testing, but not ideal either.
    core.info("Simulating the restore of GITHUB_STATE since we're running locally...");
    const lines = fs.readFileSync(stateFilePath, 'utf-8').split(/\r?\n/);
    let currentDelimiter: string | null = null;
    let currentKey: string | null = null;
    let currentValue: string = '';
    for (const line of lines) {
        if (currentKey === null) {
            const splitIndex = line.indexOf('<<');
            currentKey = line.substring(0, splitIndex);
            currentDelimiter = line.substring(splitIndex + 2);
            currentValue = '';
            continue;
        }

        if (line == currentDelimiter) {
            process.env[`STATE_${currentKey}`] = currentValue;
            core.debug(`STATE_${currentKey} = '${currentValue}'`);
            currentKey = null;
            continue;
        }

        if (currentValue.length > 0) {
            currentValue += '\n';
        }

        currentValue += line;
    }
}
