import * as core from '@actions/core';
import * as io from '@actions/io';
import * as installer from './installer';
import * as semver from 'semver';
import path from 'path';
import {restoreCache} from './cache-restore';
import {isCacheFeatureAvailable} from './cache-utils';
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import {IToolRelease} from '@actions/tool-cache';
import {StableReleaseAlias} from './utils';

export async function run() {
  try {
    //
    // versionSpec is optional.  If supplied, install / use from the tool cache
    // If not supplied then problem matchers will still be setup.  Useful for self-hosted.
    //
    const versionSpec = resolveVersionInput();

    const cache = core.getBooleanInput('cache');
    core.info(`Setup go version spec ${versionSpec}`);

    let arch = core.getInput('architecture');

    if (!arch) {
      arch = os.arch();
    }

    if (versionSpec) {
      let token = core.getInput('token');
      let auth = !token ? undefined : `token ${token}`;

      const manifest = await installer.getManifest(auth);

      const checkLatest = core.getBooleanInput('check-latest');

      const installDir = await installer.getGo(
        versionSpec,
        checkLatest,
        auth,
        arch,
        manifest
      );

      core.addPath(path.join(installDir, 'bin'));
      core.info('Added go to the path');

      const version = installer.makeSemver(versionSpec);
      // Go versions less than 1.9 require GOROOT to be set
      if (semver.lt(version, '1.9.0')) {
        core.info('Setting GOROOT for Go version < 1.9');
        core.exportVariable('GOROOT', installDir);
      }

      let added = await addBinToPath();
      core.debug(`add bin ${added}`);
      core.info(`Successfully set up Go version ${versionSpec}`);
    }

    if (cache && isCacheFeatureAvailable()) {
      const packageManager = 'default';
      const cacheDependencyPath = core.getInput('cache-dependency-path');
      await restoreCache(versionSpec, packageManager, cacheDependencyPath);
    }

    // add problem matchers
    const matchersPath = path.join(__dirname, '../..', 'matchers.json');
    core.info(`##[add-matcher]${matchersPath}`);

    // output the version actually being used
    let goPath = await io.which('go');
    let goVersion = (cp.execSync(`${goPath} version`) || '').toString();
    core.info(goVersion);

    core.setOutput('go-version', parseGoVersion(goVersion));

    core.startGroup('go env');
    let goEnv = (cp.execSync(`${goPath} env`) || '').toString();
    core.info(goEnv);
    core.endGroup();
  } catch (error) {
    core.setFailed(error.message);
  }
}

export async function addBinToPath(): Promise<boolean> {
  let added = false;
  let g = await io.which('go');
  core.debug(`which go :${g}:`);
  if (!g) {
    core.debug('go not in the path');
    return added;
  }

  let buf = cp.execSync('go env GOPATH');
  if (buf.length > 1) {
    let gp = buf.toString().trim();
    core.debug(`go env GOPATH :${gp}:`);
    if (!fs.existsSync(gp)) {
      // some of the hosted images have go install but not profile dir
      core.debug(`creating ${gp}`);
      await io.mkdirP(gp);
    }

    let bp = path.join(gp, 'bin');
    if (!fs.existsSync(bp)) {
      core.debug(`creating ${bp}`);
      await io.mkdirP(bp);
    }

    core.addPath(bp);
    added = true;
  }
  return added;
}

export function parseGoVersion(versionString: string): string {
  // get the installed version as an Action output
  // based on go/src/cmd/go/internal/version/version.go:
  // fmt.Printf("go version %s %s/%s\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
  // expecting go<version> for runtime.Version()
  return versionString.split(' ')[2].slice('go'.length);
}

function resolveVersionInput(): string {
  let version = core.getInput('go-version');
  const versionFilePath = core.getInput('go-version-file');

  if (version && versionFilePath) {
    core.warning(
      'Both go-version and go-version-file inputs are specified, only go-version will be used'
    );
  }

  if (version) {
    return version;
  }

  if (versionFilePath) {
    if (!fs.existsSync(versionFilePath)) {
      throw new Error(
        `The specified go version file at: ${versionFilePath} does not exist`
      );
    }
    version = installer.parseGoVersionFile(versionFilePath);
  }

  return version;
}
