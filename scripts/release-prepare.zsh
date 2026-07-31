#!/bin/zsh

emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL NO_CLOBBER
umask 077

typeset -r script_dir=${0:A:h}
typeset -r repository=${script_dir:h}
typeset -r evidence_root=${1:-${HOME}/.journal/release-evidence}
typeset -r release_root=${2:-${HOME}/.journal/releases}
typeset -r current_link=${HOME}/.journal/current-release

[[ ${PWD:A} == ${repository:A} ]] || {
  print -u2 -- "Run this helper from the canonical checkout: ${repository}"
  exit 1
}
[[ ${evidence_root:A} != ${repository:A} && ${evidence_root:A} != ${repository:A}/* ]] || {
  print -u2 -- 'Release evidence must be outside the source tree.'
  exit 1
}
for command_name in git jq node npm shasum; do
  command -v ${command_name} >/dev/null || {
    print -u2 -- "Required command is missing: ${command_name}"
    exit 1
  }
done
(( EUID != 0 )) || {
  print -u2 -- 'Release preparation must not run as root.'
  exit 1
}

[[ -f .nvmrc ]] || {
  print -u2 -- 'Missing .nvmrc in the canonical checkout.'
  exit 1
}
typeset expected_node actual_node
expected_node=$(tr -d '[:space:]' < .nvmrc)
expected_node=${expected_node#v}
actual_node=$(node --version)
actual_node=${actual_node#v}
[[ ${actual_node} == ${expected_node} ]] || {
  print -u2 -- "Node must exactly match .nvmrc (${expected_node}); got v${actual_node}."
  exit 1
}

typeset release_mode previous_release=''
if [[ -L ${current_link} ]]; then
  previous_release=${current_link:A}
  [[ -d ${previous_release} && ${previous_release:A} == ${release_root:A}/* ]] || {
    print -u2 -- "current-release is not a valid release-root symlink: ${current_link}"
    exit 1
  }
  release_mode=upgrade
elif [[ -e ${current_link} ]]; then
  print -u2 -- "Ambiguous current-release ownership: ${current_link} exists but is not a symlink."
  exit 1
else
  release_mode=first-install
fi

install -d -m 700 -- ${evidence_root}
typeset release_timestamp release_commit stamp
release_timestamp=$(date -u +%Y%m%dT%H%M%SZ)
release_commit=$(git rev-parse --short=12 HEAD)
stamp=${release_timestamp}-${release_commit}-$$
typeset -r stamp
typeset -r manifest=${evidence_root}/release-manifest-${stamp}.json
typeset -r archive=${evidence_root}/release-tree-${stamp}.tgz
typeset -r attestation=${evidence_root}/release-attestation-${stamp}.json
typeset -r benchmark=${evidence_root}/release-benchmark-${stamp}.json
typeset -r ledger=${evidence_root}/verification-ledger-${stamp}.md
typeset -r context=${evidence_root}/release-context-${stamp}.json
typeset -r context_next=${context}.next
typeset -r staged_release=${release_root}/${stamp}

for release_artifact_path in ${manifest} ${archive} ${attestation} ${benchmark} ${ledger} ${context} ${context_next} ${staged_release}; do
  [[ ! -e ${release_artifact_path} && ! -L ${release_artifact_path} ]] || {
    print -u2 -- "Refusing to overwrite release artifact: ${release_artifact_path}"
    exit 1
  }
done
/bin/cp -- docs/verification.md ${ledger}
chmod 600 ${ledger}

npm ci
npm audit --audit-level=high
npm run check
npm exec tsc -- --project e2e/tsconfig.json
CI=1 npm run test:e2e
node scripts/benchmark-release.mjs --spawn-isolated --output ${benchmark}

# Playwright's webServer command performs the final production build. The isolated NFR
# benchmark consumes that bundle without rebuilding; archive the same browser-tested bytes.
node scripts/release-manifest.mjs --output ${manifest}
node scripts/release-archive.mjs \
  --manifest ${manifest} \
  --archive ${archive} \
  --attestation ${attestation} \
  --stamp ${stamp}

typeset benchmark_sha256 base_commit manifest_sha256 archive_sha256
benchmark_sha256=$(shasum -a 256 ${benchmark} | awk '{print $1}')
base_commit=$(jq -er '.baseCommit' ${attestation})
manifest_sha256=$(jq -er '.manifest.sha256' ${attestation})
archive_sha256=$(jq -er '.archive.sha256' ${attestation})
trap '/bin/rm -f -- ${context_next}' EXIT
jq -n \
  --arg stamp "${stamp}" \
  --arg mode "${release_mode}" \
  --arg previousRelease "${previous_release}" \
  --arg releaseRoot "${staged_release}" \
  --arg manifest "${manifest}" \
  --arg archive "${archive}" \
  --arg attestation "${attestation}" \
  --arg benchmark "${benchmark}" \
  --arg ledger "${ledger}" \
  --arg benchmarkSha256 "${benchmark_sha256}" \
  --arg baseCommit "${base_commit}" \
  --arg manifestSha256 "${manifest_sha256}" \
  --arg archiveSha256 "${archive_sha256}" \
  '{
    schemaVersion: 1,
    releaseStamp: $stamp,
    mode: $mode,
    previousRelease: $previousRelease,
    releaseRoot: $releaseRoot,
    manifest: $manifest,
    archive: $archive,
    attestation: $attestation,
    benchmark: $benchmark,
    benchmarkSha256: $benchmarkSha256,
    ledger: $ledger,
    baseCommit: $baseCommit,
    manifestSha256: $manifestSha256,
    archiveSha256: $archiveSha256
  }' > ${context_next}
jq -e \
  --arg stamp "${stamp}" \
  --arg mode "${release_mode}" \
  --arg previousRelease "${previous_release}" \
  --arg releaseRoot "${staged_release}" \
  '.schemaVersion == 1 and .releaseStamp == $stamp and .mode == $mode and
    .previousRelease == $previousRelease and .releaseRoot == $releaseRoot and
    (.manifestSha256 | type == "string" and length == 64) and
    (.archiveSha256 | type == "string" and length == 64)' \
  ${context_next} >/dev/null
chmod 600 ${context_next}
mv -- ${context_next} ${context}
trap - EXIT

print -- ${context}
