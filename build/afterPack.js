// VMP-signerar Windows/macOS-paket så Widevine (Netflix m.fl.) funkar i den
// distribuerade appen. LINUX behöver INGEN VMP-signering (Widevine L3 funkar utan)
// och castlabs sign-pkg stödjer inte Linux — hoppas därför över.
// Kräver ett castlabs EVS-konto EN gång (~/.castlabs-evs-venv/bin/python -m castlabs_evs.account signup).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function evsPython() {
  const venv = path.join(os.homedir(), '.castlabs-evs-venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : (process.env.EVS_PYTHON || 'python3');
}

exports.default = async function afterPack(context) {
  const plat = context.electronPlatformName; // 'linux' | 'darwin' | 'win32'
  if (plat === 'linux') {
    console.log('[VMP] Linux behöver ingen VMP-signering (Widevine L3 funkar utan) — hoppar över.');
    return;
  }
  const appOutDir = context.appOutDir;
  const py = evsPython();
  const evsCfg = path.join(os.homedir(), '.config', 'evs', 'config.json');
  if (!fs.existsSync(evsCfg) && !process.env.EVS_FORCE) {
    console.warn('\n[VMP] ⚠  Inget castlabs EVS-konto (~/.config/evs/config.json saknas).');
    console.warn('[VMP] ⚠  Hoppar över signering — Widevine/Netflix funkar INTE i detta win/mac-bygge.\n');
    return;
  }
  console.log('[VMP] Signerar', plat, 'paket:', appOutDir);
  execFileSync(py, ['-m', 'castlabs_evs.vmp', 'sign-pkg', appOutDir], { stdio: 'inherit' });
  console.log('[VMP] ✓ Klart — Widevine aktiverat i bygget.');
};
