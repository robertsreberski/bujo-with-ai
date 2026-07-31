#!/bin/zsh

emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL
umask 077

typeset -r script_dir=${0:A:h}
typeset -r repository=${script_dir:h}
typeset -r context=${1:?Usage: release-stage.zsh <release-context.json>}
[[ ${PWD:A} == ${repository:A} ]] || {
  print -u2 -- "Run this helper from the canonical checkout: ${repository}"
  exit 1
}
[[ -f ${context} ]] || {
  print -u2 -- "Release context does not exist: ${context}"
  exit 1
}
for command_name in jq node npm shasum tar; do
  command -v ${command_name} >/dev/null || {
    print -u2 -- "Required command is missing: ${command_name}"
    exit 1
  }
done
[[ -x /usr/bin/perl ]] || {
  print -u2 -- 'Required command is missing: /usr/bin/perl'
  exit 1
}
[[ -x /usr/bin/lockf ]] || {
  print -u2 -- 'Required command is missing: /usr/bin/lockf'
  exit 1
}

function bounded_command {
  typeset -r journal_command_timeout=$1
  shift
  /usr/bin/perl -MTime::HiRes=alarm -e '
    my $timeout = shift @ARGV;
    alarm($timeout);
    exec { $ARGV[0] } @ARGV;
    die "exec failed: $!";
  ' ${journal_command_timeout} "$@"
}

typeset stamp manifest archive attestation final_release
stamp=$(jq -er '.releaseStamp' ${context})
manifest=$(jq -er '.manifest' ${context})
archive=$(jq -er '.archive' ${context})
attestation=$(jq -er '.attestation' ${context})
final_release=$(jq -er '.releaseRoot' ${context})
typeset -r stamp manifest archive attestation final_release
typeset -r releases_root=${HOME}/.journal/releases
typeset -r evidence_root=${context:A:h}
typeset -r deployed_attestation=${evidence_root}/deployed-tree-${stamp}.json
typeset -r stage_lock=${evidence_root}/stage-${stamp}.lock
typeset -r stamp_pattern='^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$'
[[ ${stamp} =~ ${stamp_pattern} ]] || {
  print -u2 -- "Invalid release stamp: ${stamp}"
  exit 1
}
if [[ ! -e ${stage_lock} && ! -L ${stage_lock} ]]; then
  ( setopt NO_CLOBBER; : > ${stage_lock} ) 2>/dev/null || true
fi
[[ -f ${stage_lock} && ! -L ${stage_lock} && -O ${stage_lock} ]] || {
  print -u2 -- 'Stage lock is not an owner-controlled regular file.'
  exit 1
}
chmod 600 ${stage_lock}
typeset stage_lock_fd
exec {stage_lock_fd}<>${stage_lock}
typeset -r stage_lock_fd
[[ $(/usr/bin/stat -f '%i:%Lp:%l:%u' ${stage_lock}) == \
   $(/usr/bin/stat -f '%i:%Lp:%l:%u' /dev/fd/${stage_lock_fd}) ]] || {
  print -u2 -- 'Stage lock identity changed while it was opened.'
  exit 1
}
/usr/bin/lockf -s -t 0 ${stage_lock_fd} || {
  print -u2 -- 'Another process is staging this release context.'
  exit 1
}
[[ ${final_release} == ${releases_root}/${stamp} ]] || {
  print -u2 -- 'Release root and release stamp do not match.'
  exit 1
}
typeset resume_existing=0
if [[ -e ${final_release} || -L ${final_release} ]]; then
  [[ -d ${final_release} && ! -L ${final_release} && ${final_release:A} == ${releases_root:A}/${stamp} ]] || {
    print -u2 -- "Immutable release path is ambiguous: ${final_release}"
    exit 1
  }
  resume_existing=1
fi
typeset expected_stage_sha
expected_stage_sha=$(jq -er \
  '.files[] | select(.path == "scripts/release-stage.zsh" and .kind == "file") | .sha256' \
  ${manifest})
typeset -r expected_stage_sha
typeset stage_sha actual_manifest_sha context_manifest_sha actual_archive_sha context_archive_sha
stage_sha=$(shasum -a 256 ${0:A} | awk '{print $1}')
actual_manifest_sha=$(shasum -a 256 ${manifest} | awk '{print $1}')
context_manifest_sha=$(jq -er '.manifestSha256' ${context})
actual_archive_sha=$(shasum -a 256 ${archive} | awk '{print $1}')
context_archive_sha=$(jq -er '.archiveSha256' ${context})
[[ ${stage_sha} == ${expected_stage_sha} ]] || {
  print -u2 -- 'release-stage.zsh changed after release attestation.'
  exit 1
}
[[ ${actual_manifest_sha} == ${context_manifest_sha} ]] || {
  print -u2 -- 'Manifest hash no longer matches the release context.'
  exit 1
}
[[ ${actual_archive_sha} == ${context_archive_sha} ]] || {
  print -u2 -- 'Archive hash no longer matches the release context.'
  exit 1
}
typeset attested_manifest_sha attested_archive_sha
attested_manifest_sha=$(jq -er '.manifestSha256' ${context})
attested_archive_sha=$(jq -er '.archiveSha256' ${context})
jq -e \
  --arg stamp "${stamp}" \
  --arg manifestSha256 "${attested_manifest_sha}" \
  --arg archiveSha256 "${attested_archive_sha}" \
  '.releaseStamp == $stamp and .manifest.sha256 == $manifestSha256 and .archive.sha256 == $archiveSha256 and .extractedTreeVerified == true' \
  ${attestation} >/dev/null
typeset actual_node_version expected_node_version actual_node_path expected_node_path
typeset actual_npm_version expected_npm_version
actual_node_version=$(node --version)
expected_node_version=$(jq -er '.toolchain.node' ${manifest})
actual_node_path=$(node -p 'process.execPath')
expected_node_path=$(jq -er '.toolchain.nodePath' ${manifest})
actual_npm_version=$(npm --version)
expected_npm_version=$(jq -er '.toolchain.npm' ${manifest})
[[ ${actual_node_version} == ${expected_node_version} && \
    ${actual_node_path} == ${expected_node_path} && \
    ${actual_npm_version} == ${expected_npm_version} ]] || {
  print -u2 -- 'Staging toolchain no longer matches the attested release toolchain.'
  exit 1
}

if (( resume_existing == 1 )); then
  [[ -f ${deployed_attestation} && ! -L ${deployed_attestation} ]] || {
    print -u2 -- 'Existing immutable release has no deployed-tree attestation.'
    exit 1
  }
  ${expected_node_path} ${final_release}/scripts/release-deployed-tree.mjs --verify \
    --context ${context} --root ${final_release} --attestation ${deployed_attestation} >/dev/null
  print -- ${final_release}
  exit 0
fi

install -d -m 700 -- ${releases_root}
typeset -r staging=${releases_root}/.staging-${stamp}-$$
[[ ! -e ${staging} && ! -L ${staging} ]] || {
  print -u2 -- "Staging path already exists: ${staging}"
  exit 1
}
install -d -m 700 -- ${staging}

function cleanup_staging {
  if [[ -n ${staging:-} && ${staging:A} == ${releases_root:A}/.staging-${stamp}-* ]]; then
    find -P ${staging} -type d -exec chmod u+w {} + 2>/dev/null || true
    rm -rf -- ${staging}
  fi
}
function abort_staging {
  typeset -r journal_signal_exit=$1
  trap - EXIT HUP INT TERM
  cleanup_staging
  exit ${journal_signal_exit}
}
trap cleanup_staging EXIT
trap 'abort_staging 129' HUP
trap 'abort_staging 130' INT
trap 'abort_staging 143' TERM

tar -xzpf ${archive} -C ${staging}
node ${staging}/scripts/release-manifest.mjs --verify ${manifest} ${staging}
${expected_node_path} ${staging}/scripts/release-deployed-tree.mjs --discard-incomplete \
  --context ${context} --attestation ${deployed_attestation} >/dev/null

(
  cd ${staging}
  npm ci --omit=dev
  bounded_command 30 ${expected_node_path} scripts/release-staged-smoke.mjs
)
node ${staging}/scripts/release-manifest.mjs --verify \
  ${manifest} ${staging} --allow-extra node_modules

# Make every non-symlink staged path owner-readable/executable as originally needed,
# but non-writable and inaccessible to group/other users.
find -P ${staging} ! -type l -exec chmod go-rwx,u-w {} +
node ${staging}/scripts/release-manifest.mjs --verify \
  ${manifest} ${staging} --allow-extra node_modules --ignore-mode
typeset unsafe_path
unsafe_path=$(find -P ${staging} ! -type l \( -perm -0222 -o -perm -0077 \) -print -quit)
[[ -z ${unsafe_path} ]] || {
  print -u2 -- 'Staged release contains writable or non-owner-accessible paths.'
  exit 1
}

${expected_node_path} ${staging}/scripts/release-deployed-tree.mjs --create \
  --context ${context} --root ${staging} --attestation ${deployed_attestation} >/dev/null

mv -- ${staging} ${final_release}
${expected_node_path} -e \
  'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' \
  ${releases_root}
${expected_node_path} ${final_release}/scripts/release-deployed-tree.mjs --verify \
  --context ${context} --root ${final_release} --attestation ${deployed_attestation} >/dev/null
trap - EXIT HUP INT TERM
print -- ${final_release}
