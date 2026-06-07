#!/usr/bin/env node

/**
 * 版本更新自動化腳本
 * 用於自動更新 config.json 中的 git commit hash 和版本號
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, "..", "data", "config.json");
const PACKAGE_PATH = path.join(__dirname, "..", "package.json");

/**
 * 取得 git commit hash
 */
function getGitCommitHash(length = 7) {
  try {
    return execSync(`git rev-parse --short=${length} HEAD`, {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    console.error("無法取得 git commit hash:", error.message);
    return null;
  }
}

/**
 * 讀取 config.json
 */
function readConfig() {
  try {
    const configData = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(configData);
  } catch (error) {
    console.error("讀取 config.json 失敗:", error.message);
    process.exit(1);
  }
}

/**
 * 寫入 config.json
 */
function writeConfig(config) {
  try {
    // 格式化 JSON（縮排 4 個空格）
    const formattedConfig = JSON.stringify(config, null, 4);
    fs.writeFileSync(CONFIG_PATH, formattedConfig + "\n", "utf8");
    console.log("config.json 已更新");
  } catch (error) {
    console.error("寫入 config.json 失敗:", error.message);
    process.exit(1);
  }
}

/**
 * 讀取 package.json
 */
function readPackageJson() {
  try {
    const packageData = fs.readFileSync(PACKAGE_PATH, "utf8");
    return JSON.parse(packageData);
  } catch (error) {
    console.error("讀取 package.json 失敗:", error.message);
    process.exit(1);
  }
}

/**
 * 寫入 package.json
 */
function writePackageJson(packageJson) {
  try {
    const formattedPackage = JSON.stringify(packageJson, null, 4);
    fs.writeFileSync(PACKAGE_PATH, formattedPackage + "\n", "utf8");
    console.log("package.json 已更新");
  } catch (error) {
    console.error("寫入 package.json 失敗:", error.message);
    process.exit(1);
  }
}

/**
 * 更新 git commit hash
 */
function updateGitCommitHash() {
  const config = readConfig();
  const currentHash = config.git_commit_hash;
  const newHash = getGitCommitHash();

  if (!newHash) {
    console.error("無法取得 git commit hash");
    process.exit(1);
  }

  if (currentHash === newHash) {
    console.log(`git commit hash 無變化: ${currentHash}`);
    return false;
  }

  console.log(`更新 git commit hash: ${currentHash} → ${newHash}`);
  config.git_commit_hash = newHash;
  // 使用設定檔中的時區設定
  const timezone = config.timezone || "Asia/Taipei";
  config.updated_at =
    new Date()
      .toLocaleString("zh-TW", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      .replace(/\//g, "-") + ".000Z";

  writeConfig(config);
  return true;
}

/**
 * 解析版本號，回傳 { major, minor }
 */
function parseVersion(version) {
  const parts = String(version || "1.0").split(".");
  return {
    major: parseInt(parts[0]) || 1,
    minor: parseInt(parts[1]) || 0,
  };
}

/**
 * 將新版本號寫入 config.json 與 package.json
 */
function applyVersion(newVersion) {
  const config = readConfig();
  const currentVersion = config.version;

  if (currentVersion === newVersion) {
    console.log(`版本號無變化: ${currentVersion}`);
    return false;
  }

  console.log(`更新版本號: ${currentVersion} → ${newVersion}`);
  config.version = newVersion;
  const timezone = config.timezone || "Asia/Taipei";
  config.updated_at =
    new Date()
      .toLocaleString("zh-TW", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      .replace(/\//g, "-") + ".000Z";
  writeConfig(config);

  const packageJson = readPackageJson();
  if (packageJson.version !== newVersion) {
    packageJson.version = newVersion;
    writePackageJson(packageJson);
  }
  return true;
}

/**
 * 更新版本號（hash patch，major.minor 不變）
 */
function updateVersion() {
  const config = readConfig();
  const { major, minor } = parseVersion(config.version);
  const gitHash = getGitCommitHash();
  if (!gitHash) { console.error("無法取得 git commit hash"); process.exit(1); }
  return applyVersion(`${major}.${minor}.${gitHash}`);
}

/**
 * 次版本號 +1，patch 更新為當前 hash
 */
function bumpMinor() {
  const config = readConfig();
  const { major, minor } = parseVersion(config.version);
  const gitHash = getGitCommitHash();
  if (!gitHash) { console.error("無法取得 git commit hash"); process.exit(1); }
  return applyVersion(`${major}.${minor + 1}.${gitHash}`);
}

/**
 * 主版本號 +1，次版本號歸零，patch 更新為當前 hash
 */
function bumpMajor() {
  const config = readConfig();
  const { major } = parseVersion(config.version);
  const gitHash = getGitCommitHash();
  if (!gitHash) { console.error("無法取得 git commit hash"); process.exit(1); }
  return applyVersion(`${major + 1}.0.${gitHash}`);
}

/**
 * 顯示幫助資訊
 */
function showHelp() {
  console.log(`
版本更新自動化腳本

用法:
  node scripts/update-version.js [command]

命令:
  hash          更新 git commit hash（版本號不變）
  version       更新 patch（hash），major.minor 不變
  bump-minor    次版本號 +1（2.6.X → 2.7.X）
  bump-major    主版本號 +1，次版本號歸零（2.6.X → 3.0.X）
  all           更新 hash 和 patch 版本
  status        顯示目前狀態

範例:
  node scripts/update-version.js bump-minor
  node scripts/update-version.js bump-major
  node scripts/update-version.js version
  node scripts/update-version.js all
`);
}

/**
 * 顯示目前狀態
 */
function showStatus() {
  const config = readConfig();
  const currentGitHash = getGitCommitHash();

  console.log("目前狀態:");
  console.log(`   設定檔版本: ${config.version}`);
  console.log(`   設定檔 git hash: ${config.git_commit_hash || "未設定"}`);
  console.log(`   實際 git hash: ${currentGitHash || "無法取得"}`);
  console.log(`   最後更新: ${config.updated_at}`);
}

// 主程式
const command = process.argv[2];

switch (command) {
  case "hash":
    updateGitCommitHash();
    break;
  case "version":
    updateVersion();
    break;
  case "bump-minor":
    bumpMinor();
    break;
  case "bump-major":
    bumpMajor();
    break;
  case "all": {
    const hashUpdated = updateGitCommitHash();
    const versionUpdated = updateVersion();
    if (!hashUpdated && !versionUpdated) console.log("所有項目都是最新的");
    break;
  }
  case "status":
    showStatus();
    break;
  default:
    showHelp();
    break;
}
