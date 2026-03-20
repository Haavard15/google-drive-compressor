'use strict';

const notarizeEnabled =
  !process.env.SKIP_NOTARIZE &&
  Boolean(
    process.env.APPLE_ID &&
      process.env.APPLE_APP_SPECIFIC_PASSWORD &&
      process.env.APPLE_TEAM_ID,
  );

const macConfig = {
  target: ['dmg'],
  category: 'public.app-category.productivity',
  hardenedRuntime: true,
  gatekeeperAssess: false,
  entitlements: 'build/entitlements.mac.plist',
  entitlementsInherit: 'build/entitlements.mac.inherit.plist',
};

if (process.env.APPLE_SIGNING_IDENTITY) {
  macConfig.identity = process.env.APPLE_SIGNING_IDENTITY;
}

if (notarizeEnabled) {
  macConfig.notarize = {
    teamId: process.env.APPLE_TEAM_ID,
  };
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
