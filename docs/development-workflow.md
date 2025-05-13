# Developing setup-bonsai

[Developing a GitHub Actions action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-javascript-action) is a bit unusual compared to what you might be used to.

In particular, the build output of everything in an action is comitted along with the source code. The build output located within this repository is what's actually used by GitHub Actions when the action is incorporated into a workflow. As such it's easier if it's just always present and up-to-date so that referencing the action at revision A will actually run the code at revision A.

As such, it is intended that you leave build watchers running in the background at all times while you're working on this action so that the build output will always be up to date when you go to commit.

There are two primary watch commands for each of the two action entrypoints:

* `npm run watch-main`
* `npm run watch-post`

Additionally you should also run `npm run verify -- --watch` and leave that terminal up somewhere visible.

The actual builds use [esbuild](https://esbuild.github.io/), which is very fast but merely transpiles the TypeScript to JavaScript and bundles the action without verifying any type annotations.

As such, in order to verify your TypeScript is actually valid you need to use the `verify` command as described above.

Finally, if you have to work on `BonsaiPackageInstallHelper` then you must manually ensure it is built before you commit by running `npm run build-dotnet`.
