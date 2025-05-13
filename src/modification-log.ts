import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import { strict as assert } from 'assert';
import * as path from 'path';
import * as util from './util';

const modificationLogFolder = 'modification-log';
const modificationLogFileSuffix = '#MODIFICATION.log';
const modifiedVersionSuffix = '#MODIFIED';
const runInfoFileName = 'run-info.json';

// Used to indicate an intent to modify a file that was provided by the user (IE: a file from the repo we're running for.)
export function logFileModificationIntent(filePath: string, extraInfo?: any): void {
    if (!core.isDebug() && !util.actionIsUnderTest) {
        return;
    }

    try {
        const relativePath = path.relative(process.cwd(), filePath);
        core.info(`Logging intent to modify '${relativePath}'...`);
        const backupPath = util.getTemporaryPath(modificationLogFolder, relativePath);

        // Save a backup of the original file if it's not already in the log.
        if (!fs.existsSync(backupPath)) {
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.copyFileSync(filePath, backupPath);
        }

        const modificationLogPath = `${backupPath}${modificationLogFileSuffix}`;

        const stackCapture = { name: `Modfication by ${util.invocationId}`, stack: '' };
        Error.captureStackTrace(stackCapture, logFileModificationIntent);

        let modificationLogEntry = `${'='.repeat(160)}\n${stackCapture.stack}\n\n`;

        if (extraInfo) {
            modificationLogEntry += `${JSON.stringify(extraInfo, null, 2)}\n\n`;
        }

        fs.writeFileSync(modificationLogPath, modificationLogEntry, { flag: 'a' });
    } catch (error) {
        core.warning(`Failed to log modification intent: ${error}`);
    }
}

export async function archiveModificationLog() {
    const backupRoot = util.getTemporaryPath(modificationLogFolder);
    if (!fs.existsSync(backupRoot)) {
        // Create the log if it was never created, this ensures we still capture the run info
        fs.mkdirSync(backupRoot);
    }

    // Loop through all of the files in the modification log to create the log archive
    core.debug("Capturing modified files and building modification log...");
    const backupFiles = fs.readdirSync(backupRoot, { withFileTypes: true, recursive: true });
    const archiveFiles = [];
    for (const file of backupFiles) {
        if (!file.isFile()) {
            continue;
        }

        const filePath = path.join(file.parentPath, file.name);
        const parsedFilePath = path.parse(filePath);

        // Nothing to do with an existing run info file, it will be regenerated and archived down below.
        if (file.name == runInfoFileName) {
            continue;
        }

        // Nothing to do with an existing modified version
        // This file would have be left over from a previous action invocation and will be refreshed and added when the corresponding original is processed.
        if (parsedFilePath.name.endsWith(modifiedVersionSuffix)) {
            continue;
        }

        // If the file is a modification log then we simply add it to the archive
        if (file.name.endsWith(modificationLogFileSuffix)) {
            archiveFiles.push(filePath);
            continue;
        }

        // At this point we should have a backup of a file that is present in the repository
        // Find the associated modified file in the repo and copy it into the log for archival
        const relativePath = path.relative(backupRoot, filePath);
        const modifiedVersionPath = `${filePath}${modifiedVersionSuffix}${parsedFilePath.ext}`;
        if (fs.existsSync(relativePath)) {
            fs.copyFileSync(relativePath, modifiedVersionPath);
        } else {
            fs.writeFileSync(modifiedVersionPath, '!!! file was removed !!!');
        }

        // Add both the original and the modified files to the archive
        archiveFiles.push(filePath);
        archiveFiles.push(modifiedVersionPath);
    }

    const runInfoPath = path.join(backupRoot, runInfoFileName);
    const runInfo = {
        invocationId: util.invocationId,
        actionIsUnderTest: util.actionIsUnderTest,
        isDebug: core.isDebug(),
        platform: `${process.platform} ${process.arch}`,
        inputs: util.inputs,
        githubContext: github.context,
    };
    fs.writeFileSync(runInfoPath, JSON.stringify(runInfo, null, 2));
    archiveFiles.push(runInfoPath);

    if (util.actionIsUnderTest) {
        using _ = new util.ScopedGroup(`Can't upload archive of moficiation log when running locally, here's what would've been included:`);
        archiveFiles.forEach(f => core.info(`- ${f}`));
    } else {
        await util.uploadDebugArtifact(
            'modification-log',
            'modification log',
            archiveFiles,
            backupRoot
        );
    }
}

export function restoreModifiedFiles(): void {
    if (!util.actionIsUnderTest) {
        // It's not expected that this should ever be desired outside of local testing
        // Doing this in the middle of an actual CI run is likely to be very error-prone, we'd need a strong compelling reason to enable it
        throw Error("Restoring modified files should not be done except when testing locally!");
    }

    core.info("Restoring the repository to its original state by undoing the changes present in the modification log...");

    const backupRoot = util.getTemporaryPath(modificationLogFolder);
    if (!fs.existsSync(backupRoot)) {
        core.info("Nothing to restore, modification log is empty.");
        return;
    }

    const backupFiles = fs.readdirSync(backupRoot, { withFileTypes: true, recursive: true });
    for (const file of backupFiles) {
        const filePath = path.join(file.parentPath, file.name);
        const relativePath = path.relative(backupRoot, filePath);

        if (
            !file.isFile()
            || file.name == runInfoFileName
            || file.name.endsWith(modificationLogFileSuffix)
            || path.parse(file.name).name.endsWith(modifiedVersionSuffix)
        ) {
            core.info(`Taking no action for '${relativePath}'`);
            continue;
        }

        core.info(`Restore '${relativePath}' from '${filePath}''`);
        fs.copyFileSync(filePath, relativePath);
    }

    // Avoid disaster, don't delete the modification log if it doesn't look like one
    // Learned this the hard way once :(
    if (backupRoot.length <= 1 || !fs.existsSync(path.join(backupRoot, runInfoFileName))) {
        throw Error(`The modification log root '${backupRoot}' does not look like a modification log! Refusing to delete it.`);
    }

    fs.rmSync(backupRoot, { recursive: true });
}
