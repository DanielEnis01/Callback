// electron-builder has no paid Apple Developer ID cert to sign with, so it
// ships the .app fully unsigned -- and on Apple Silicon, Gatekeeper refuses
// to even launch a downloaded, fully-unsigned app ("Callback is damaged and
// can't be opened"), not just warn about it. Ad-hoc signing (no cert,
// signature identity "-") doesn't fix that warning, but it downgrades the
// failure from "damaged, must be trashed" to the milder, bypassable
// "unidentified developer" prompt (right-click -> Open). Recipients still
// need one `xattr -cr` after unzipping/mounting to clear the quarantine
// flag macOS stamps on anything downloaded via a browser -- ad-hoc signing
// alone doesn't remove that. A real fix needs a paid Developer ID + notarization.
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync("codesign", ["--deep", "--force", "--sign", "-", appPath], { stdio: "inherit" });
    console.log(`Ad-hoc signed ${appPath}`);
  } catch (err) {
    console.warn(`Ad-hoc signing skipped (${err.message}) -- codesign is macOS-only and must run on a real Mac.`);
  }
};
