'use strict';

const macConfig = {
  target: ['dmg'],
  category: 'public.app-category.productivity',
  hardenedRuntime: true,
  gatekeeperAssess: false,
  entitlements: 'build/entitlements.mac.plist',
  entitlementsInherit: 'build/entitlements.mac.inherit.plist',
};

if (process.env.APPLE_SIGNING_IDENTITY) {
  macConfig.identity = process.env.APPLE_SIGNING_IDENTITY.replace(
    /^Developer ID Application:\s*/,
    '',
  );
}

module.exports = {
  appId: 'com.googledrivecompressor.desktop',
  productName: 'Drive Compressor',
  directories: {
    output: 'dist',
  },
  files: ['main.cjs', 'assets/**/*', '.release/**/*'],
  asarUnpack: ['**/*.node'],
  mac: macConfig,
  win: {
    target: ['nsis'],
  },
  artifactName: 'drive-compressor-${version}-${os}-${arch}.${ext}',
};
