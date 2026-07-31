#!/usr/bin/env node
/* global process */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeOwnerPrivateAtomic } from './release-atomic-file.mjs';
import { sha256File } from './release-manifest.mjs';

function value(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`${name} is required.`);
  return args[index + 1];
}

function optionalValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

function requireText(field, name) {
  if (typeof field !== 'string' || field.trim() === '') {
    throw new Error(`Device evidence requires ${name}.`);
  }
  return field.trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

export function createDeviceEvidence({
  attestationPath,
  outputPath,
  status,
  deviceModel,
  iosVersion,
  tailnetAccount,
  assignee,
  checklistReference,
  notes,
}) {
  if (status !== 'PASS' && status !== 'DEVICE HANDOFF') {
    throw new Error('Device status must be PASS or DEVICE HANDOFF.');
  }
  const normalizedNotes = requireText(notes, 'notes');
  const normalizedChecklist = requireText(checklistReference, 'checklistReference');
  let statusDetails;
  if (status === 'PASS') {
    statusDetails = {
      device: {
        model: requireText(deviceModel, 'deviceModel'),
        iosVersion: requireText(iosVersion, 'iosVersion'),
        tailnetAccount: requireText(tailnetAccount, 'tailnetAccount'),
      },
    };
  } else {
    statusDetails = { handoff: { assignee: requireText(assignee, 'assignee') } };
  }
  const attestation = readJson(attestationPath);
  if (attestation.extractedTreeVerified !== true)
    throw new Error('Release attestation is incomplete.');
  if (sha256File(attestation.manifest.path) !== attestation.manifest.sha256) {
    throw new Error('Manifest no longer matches release attestation.');
  }
  if (sha256File(attestation.archive.path) !== attestation.archive.sha256) {
    throw new Error('Archive no longer matches release attestation.');
  }
  const evidence = {
    schemaVersion: 2,
    releaseStamp: attestation.releaseStamp,
    status,
    recordedAt: new Date().toISOString(),
    baseCommit: attestation.baseCommit,
    manifestSha256: attestation.manifest.sha256,
    archiveSha256: attestation.archive.sha256,
    checklistReference: normalizedChecklist,
    notes: normalizedNotes,
    ...statusDetails,
  };
  const destination = resolve(outputPath);
  writeOwnerPrivateAtomic(destination, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

function runCli() {
  const args = process.argv.slice(2);
  const contextPath = resolve(value(args, '--context'));
  const context = readJson(contextPath);
  const manifest = readJson(context.manifest);
  const attestation = readJson(context.attestation);
  if (
    attestation.releaseStamp !== context.releaseStamp ||
    attestation.baseCommit !== context.baseCommit ||
    attestation.manifest?.sha256 !== context.manifestSha256 ||
    attestation.archive?.sha256 !== context.archiveSha256
  ) {
    throw new Error('Device evidence attestation does not match the release context.');
  }
  if (
    resolve(fileURLToPath(import.meta.url)) !==
    resolve(context.releaseRoot, 'scripts/release-device-evidence.mjs')
  ) {
    throw new Error('Device evidence must run from the attested staged release.');
  }
  if (
    process.version !== manifest.toolchain.node ||
    process.execPath !== manifest.toolchain.nodePath
  ) {
    throw new Error('Device evidence Node runtime does not match the release manifest.');
  }
  const outputPath = resolve(value(args, '--output'));
  if (outputPath !== resolve(dirname(contextPath), `device-${context.releaseStamp}.json`)) {
    throw new Error('Device evidence path must match the release context and stamp.');
  }
  const evidence = createDeviceEvidence({
    attestationPath: context.attestation,
    outputPath,
    status: value(args, '--status'),
    deviceModel: optionalValue(args, '--device-model'),
    iosVersion: optionalValue(args, '--ios-version'),
    tailnetAccount: optionalValue(args, '--tailnet-account'),
    assignee: optionalValue(args, '--assignee'),
    checklistReference: value(args, '--checklist-reference'),
    notes: value(args, '--notes'),
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
