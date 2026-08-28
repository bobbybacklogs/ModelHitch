// Metro config for the monorepo layout: `modelhitch-expo` is installed as a
// `file:` symlink pointing outside this project, so Metro must watch the repo
// root and resolve bare imports from this project's node_modules. `modelhitch`
// itself comes from npm (per repo convention, examples use the published
// package) so its React resolves to this app's React — no duplicate React.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

module.exports = config;