const fs = require('fs/promises');
const path = require('path');
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require('expo/config-plugins');

const SERVICE_NAME = '.DownloadForegroundService';

function ensurePermission(manifest, permission) {
  manifest['uses-permission'] = manifest['uses-permission'] || [];
  const exists = manifest['uses-permission'].some((entry) => entry.$?.['android:name'] === permission);
  if (!exists) manifest['uses-permission'].push({ $: { 'android:name': permission } });
}

module.exports = function withDownloadForegroundService(config) {
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    ensurePermission(manifest, 'android.permission.FOREGROUND_SERVICE');
    ensurePermission(manifest, 'android.permission.FOREGROUND_SERVICE_DATA_SYNC');
    ensurePermission(manifest, 'android.permission.POST_NOTIFICATIONS');

    const application = manifest.application?.[0];
    if (!application) throw new Error('Download Max foreground-service plugin: Android application node missing.');
    application.service = application.service || [];
    const alreadyAdded = application.service.some((entry) => entry.$?.['android:name'] === SERVICE_NAME);
    if (!alreadyAdded) {
      application.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:exported': 'false',
          'android:foregroundServiceType': 'dataSync',
          'android:stopWithTask': 'false',
        },
      });
    }
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    const source = mod.modResults.contents;
    const registration = 'add(DownloadForegroundServicePackage())';
    if (!source.includes(registration)) {
      const marker = /PackageList\(this\)\.packages\.apply\s*\{/;
      if (!marker.test(source)) {
        throw new Error('Download Max foreground-service plugin: could not find the React package list in MainApplication.kt.');
      }
      mod.modResults.contents = source.replace(marker, (match) => `${match}\n          ${registration}`);
    }
    return mod;
  });

  config = withDangerousMod(config, [
    'android',
    async (mod) => {
      const packageName = mod.android?.package || 'com.anonymous.downloadmax';
      const source = path.join(mod.modRequest.projectRoot, 'plugins', 'android', 'DownloadForegroundService.kt');
      const packagePath = packageName.replace(/\./g, path.sep);
      const targetDirectory = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', packagePath);
      await fs.mkdir(targetDirectory, { recursive: true });
      await fs.copyFile(source, path.join(targetDirectory, 'DownloadForegroundService.kt'));
      return mod;
    },
  ]);

  return config;
};