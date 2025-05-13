# setup-bonsai

Action for bootstrapping [Bonsai environments](https://bonsai-rx.org/docs/articles/environments) from GitHub Actions workflows.

To help speed up your CI, this action will (by default) automatically cache the Bonsai packages used to restore your environments using the [GitHub Actions cache](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows).

This action also handles injecting packages into Bonsai environments, which allows you to consume freshly built packages straight from the rest of your CI pipeline.

## Usage

Basic usage is to simply invoke the action to install bootstrap the `.bonsai` environment at the root of your repository:

```yml
- name: Set up Bonsai environment
  uses: bonsai-rx/setup-bonsai@v1
```

### Specifying the environment(s) to restore

You can specify the one or more Bonsai environments to restore using the `environment-paths` parameter:

```yml
- name: Set up Bonsai environments
  uses: bonsai-rx/setup-bonsai@v1
  with:
    environment-paths: |
      .bonsai/
      docs/examples/.bonsai/
```

Note that when possible it is preferred to pass multiple environments to a single `setup-bonsai` over invoking `setup-bonsai` multiple times. (See [this issue](https://github.com/bonsai-rx/setup-bonsai/issues/4) for details.)

You can also use [glob syntax](https://github.com/actions/toolkit/tree/36db4d62adf0bf89f2ebae569f59279e55bcd67f/packages/glob#patterns) to select multiple environments at once.

This example restores all environments across the entire repo:

```yml
- name: Set up Bonsai environments
  uses: bonsai-rx/setup-bonsai@v1
  with:
    environment-paths: **/.bonsai/
```

### Injecting packages

You can inject one or more `.nupkg` files into your Bonsai environment using the `inject-packages` parameter. Their dependencies will automatically be installed as well.

```yml
- name: Download built packages
  uses: actions/download-artifact@v4
  with:
    name: Packages
    path: artifacts/packages/

- name: Set up Bonsai environment
  uses: bonsai-rx/setup-bonsai@v1
  with:
    inject-packages: artifacts/packages/*.nupkg
```

Injected packages (and their dependencies not already present in `Bonsai.config`) are excluded from the package cache to avoid any cache poisoning issues.

(Specifically, the action captures the packages to be cached before the injected packages are even added to `Bonsai.config`.)

## Documentation

See [action.yml](action.yml) for a full list of input parameters and outputs supported by this action.

See [the documentation folder](docs/) for advanced documentation.
