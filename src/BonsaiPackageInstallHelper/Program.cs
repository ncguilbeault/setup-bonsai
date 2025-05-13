using Bonsai;
using Bonsai.Configuration;
using Bonsai.NuGet;
using NuGet.Configuration;
using NuGet.Frameworks;
using NuGet.Packaging.Core;
using NuGet.Versioning;
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Permissions;
using System.Threading;
using System.Threading.Tasks;

if (args.Length != 1)
{
    Console.Error.WriteLine("Only argument should be a path to Bonsai.exe!");
    return 1;
}

string bonsaiPath = Path.GetFullPath(args[0]);
Assembly? bonsaiAssembly = null;

AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
{
    if (new AssemblyName(args.Name).Name == nameof(Bonsai))
    {
        if (bonsaiAssembly is null)
        {
            Console.WriteLine($"Loading Bonsai from '{bonsaiPath}'...");
            bonsaiAssembly = Assembly.LoadFrom(bonsaiPath);
        }

        return bonsaiAssembly;
    }

    return null;
};

await Install(bonsaiPath);
return 0;

static async Task Install(string bonsaiPath)
{
    // Program.Main
    // Use reflection for this call since it's only present in very new versions of Bonsai
    //SystemResourcesExtensionsSupport.Initialize();
    typeof(Bonsai.Program).Assembly.GetType("SystemResourcesExtensionsSupport")?.GetMethod("Initialize")?.Invoke(null, null);

    string editorFolder = Path.GetDirectoryName(bonsaiPath);
    string editorRepositoryPath = Path.Combine(editorFolder, "Packages");
    string bonsaiConfigPath = Path.Combine(editorFolder, "Bonsai.config");

    PackageConfiguration packageConfiguration = ConfigurationHelper.Load(bonsaiConfigPath);

    // Bootstrapper.ctor
    BonsaiMachineWideSettings machineWideSettings = new();
    ISettings settings = Settings.LoadDefaultSettings(editorFolder, null, machineWideSettings);
    PackageSourceProvider sourceProvider = new(settings);
    PackageManager packageManager = new(sourceProvider, editorRepositoryPath);

    // ConsoleBootstrapper.ctor
    packageManager.Logger = ConsoleLogger.Default;

    //================================================================
    // Bootstrapper.RunAsync (loosely)
    NuGetFramework projectFramework = Launcher.ProjectFramework;

    using PackageConfigurationUpdater monitor = new
    (
        projectFramework,
        packageConfiguration,
        packageManager,
        // This argument is supposed to be optional (it's used for handling the automatic self-upgrading mechanism) but a bug prevents it from being optional
        // We still don't provide the identity so it still won't do anything unexepcted.
        bonsaiPath
    );

    // Bootstrapper.GetMissingPackages (loosely)
    foreach (PackageReference package in packageConfiguration.Packages.ToArray())
    {
        NuGetVersion? version = package.Version is string { Length: > 0 } ? NuGetVersion.Parse(package.Version) : null;
        PackageIdentity packageIdentity = new(package.Id, version);

        if (packageManager.LocalRepository.Exists(packageIdentity))
        {
            Console.WriteLine($"'{packageIdentity}' already installed.");
            continue;
        }

        Console.WriteLine($"Installing '{packageIdentity}'...");
        await packageManager.InstallPackageAsync
        (
            packageIdentity,
            projectFramework,
            ignoreDependencies: false,
            CancellationToken.None
        );
    }

    Console.WriteLine("Done.");
}
