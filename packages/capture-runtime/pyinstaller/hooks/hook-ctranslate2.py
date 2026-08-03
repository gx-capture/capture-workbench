from PyInstaller.utils.hooks import collect_dynamic_libs

binaries = collect_dynamic_libs("ctranslate2")

# CTranslate2's Windows loader resolves its DLL directory with
# importlib.resources.files(). Keep the package on disk beside those DLLs;
# a PYZ-only package can deadlock while resolving/loading the native extension.
module_collection_mode = "py"
