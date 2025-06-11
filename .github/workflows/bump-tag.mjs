import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as semver from 'semver';

const tag = process.env['TAG'];
const tagVersion = semver.parse(tag);
if (!tagVersion) {
    core.setFailed(`Tag '${tag ?? '<null>'}' is not a valid semantic version tag.`);
} else if (tagVersion.prerelease.length > 0) {
    core.info(`Main tag will not be bumped for '${tag}' as it is a pre-release tag.`);
} else {
    await exec.exec('git', ['push', '--force', 'origin', `${github.context.sha}:refs/tags/v${tagVersion.major}`]);
}
