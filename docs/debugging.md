# Debugging setup-bonsai

## Debug logging

This action supports the [step debug logging](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging#enabling-step-debug-logging) feature of GitHub Actions.

You can it for a single run by [re-running your workflow with debug logging enabled](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs).

You can enable it for all runs on a repository by [creating a variable](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables#creating-configuration-variables-for-a-repository) named `ACTIONS_STEP_DEBUG` with the value `true`.

## Debug artifacts

When you enable debug logging, `setup-bonsai` will produce a handful of helpful debugging artifacts:

* `<invocation-id>-CacheDebug.Restored.<cache-key>`
  * Contains the contents of the cache as downloaded from GitHub.
  * Only present when there's actually a cache hit.
* `<invocation-id>-CacheDebug.<cache-key>`
  * Contains the contents of the cache which will be uploaded to GitHub.
  * Not present when there was a full cache hit (as the action doesn't upload anything in that scenario.)
  * The cache is only ever uploaded to GitHub when the full workflow succeeds, but this file will be present as long as a cache would've otherwise been uploaded.
* `<invocation-id>-modification-log`
  * As part of its basic operation, `setup-bonsai` has to modify files in your Bonsai environment(s).
  * For each file which was modified, this artifact provides:
    * The original version of the file (EG: `Bonsai.config`)
    * The modified version of the file (EG: `Bonsai.config#MODIFIED.config`)
    * The log of the modifications and where in the `setup-bonsai` code they occurred (EG: `Bonsai.config#MODIFICATION.log`)
      * This log might contain multiple entries if you run `setup-bonsai` more than once in the same job.
      * Each entry is represented by a stack trace indicating where in `setup-bonsai` the modification occurred, and which invocation made the modification.
        * By default, the stack traces will not contain proper locations, see the section below for enabling source maps.
  * Also provided is `run-info.json`, which contains various metadata about the action execution context.
  * When `setup-bonsai` is invoked multiple times from the same job, this artifact will demonstrate the incremental progress.
  * For example, if you were to have two `setup-bonsai` executions in the same job:
    * The log from the first run will only contain files changed by the first run, and only the changes made by that run.
    * The log from the second run will contain files changed by both runs, and their state at the end of the second run (which would include the changes made by the first run.)

Each run of `setup-bonsai` is assigned a unique invocation ID in the form of a GUID. With debug logging enabled, the invocation GUID is printed at the very start of `setup-bonsai`.

This ID is used as a prefix for all debug artifacts as denoted by `<invocation-id>` above. This allows you to identify precisely which invocation of `setup-bonsai` produced the artifact.

## Stack traces

For performance reasons, Node.js (which is used by GitHub Actions to run the code for each action) does not print accurate source information in stack traces.

If `setup-bonsai` is crashing or you want to otherwise read stack traces produced by it, set the `NODE_OPTIONS` environment variable to `--enable-source-maps` as seen below:

```yml
- name: Set up Bonsai Environment
  uses: bonsai-rx/setup-bonsai@v1
  env:
    NODE_OPTIONS: --enable-source-maps
```
