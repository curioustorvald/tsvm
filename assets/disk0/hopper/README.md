Hopper is a package manager for TVDOS.

---

## For End Users


---

## For Package Managers

A Hopper package is declared using the Hopper Manifest. Hopper Manifest has the following fields:

- **HopperManifestVersion.** The manifest version, always `1`
- **HopperPackageName.** Package name that Hopper understands
- **HopperPackageVersion.** The version. MUST STRICTLY follow Semantic Versioning 2.0.0
  1. MAJOR version when you make incompatible API changes
  2. MINOR version when you add functionality in a backward compatible manner
  3. PATCH version when you make backward compatible bug fixes
- **HopperPackageMaintainer.** The maintainer of the package
- **HopperProvides.** (plural) What does your package provides
- **HopperRequires.** (plural) Dependencies
- **ProperName.** The displayed name of the package. Must be human-readable
- **ProperAuthor.** The displayed author of the package. Must be human-readable
- **ProperDescription.** Human-readable description of the package
- **Licence.** Licence of the package (e.g. `MIT`, `GPL-2.0-only`)
- **SupportMe.** (optional, plural) Any donation links
- **SystemPackagePath.** (for packages shipped with TVDOS only) path descriptor for the package file(s)
- **PackageFileList.** (for upstream packages, plural) HTTP(S) path for the files.