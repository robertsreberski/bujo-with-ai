#!/bin/zsh

emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL NO_CLOBBER
zmodload zsh/datetime
zmodload zsh/system
zmodload -F zsh/stat b:zstat
umask 077

typeset -r script_dir=${0:A:h}
typeset -r repository=${script_dir:h}
typeset -r action=${1:?Usage: release-cutover.zsh <apply|rollback> <release-context.json>}
typeset -r context=${2:?Usage: release-cutover.zsh <apply|rollback> <release-context.json>}
[[ ${action} == apply || ${action} == rollback ]] || {
  print -u2 -- 'Action must be apply or rollback.'
  exit 1
}
[[ ${PWD:A} == ${repository:A} ]] || {
  print -u2 -- "Run this helper from the canonical checkout: ${repository}"
  exit 1
}
[[ ${OSTYPE} == darwin* ]] || {
  print -u2 -- 'Release cutover requires macOS.'
  exit 1
}
for command_name in curl jq shasum tailscale; do
  command -v ${command_name} >/dev/null || {
    print -u2 -- "Required command is missing: ${command_name}"
    exit 1
  }
done
[[ -x /usr/bin/perl ]] || {
  print -u2 -- 'Required command is missing: /usr/bin/perl'
  exit 1
}

typeset -r global_lock=${HOME}/.journal/release-global.lock
typeset global_lock_fd=-1
typeset -A global_lock_descriptor_stat global_lock_file_stat
sysopen -rw -o creat,nofollow -m 0600 -u global_lock_fd ${global_lock} || {
  print -u2 -- 'The stable global release lock could not be opened safely.'
  exit 1
}
zstat -f ${global_lock_fd} -H global_lock_descriptor_stat
zstat -L -H global_lock_file_stat ${global_lock}
[[ ${global_lock_descriptor_stat[device]} == ${global_lock_file_stat[device]} && \
    ${global_lock_descriptor_stat[inode]} == ${global_lock_file_stat[inode]} && \
    ${global_lock_descriptor_stat[uid]} == $(id -u) && \
    ${global_lock_file_stat[uid]} == $(id -u) && \
    ${global_lock_descriptor_stat[nlink]} == 1 && \
    ${global_lock_file_stat[nlink]} == 1 && \
    $(( global_lock_descriptor_stat[mode] & 8#170000 )) == $(( 8#100000 )) && \
    $(( global_lock_file_stat[mode] & 8#170000 )) == $(( 8#100000 )) ]] || {
  print -u2 -- 'The stable global release lock has unsafe ownership or identity.'
  exit 1
}
/bin/chmod 600 /dev/fd/${global_lock_fd}
zstat -f ${global_lock_fd} -H global_lock_descriptor_stat
zstat -L -H global_lock_file_stat ${global_lock}
[[ ${global_lock_descriptor_stat[device]} == ${global_lock_file_stat[device]} && \
    ${global_lock_descriptor_stat[inode]} == ${global_lock_file_stat[inode]} && \
    ${global_lock_descriptor_stat[uid]} == $(id -u) && \
    ${global_lock_file_stat[uid]} == $(id -u) && \
    ${global_lock_descriptor_stat[nlink]} == 1 && \
    ${global_lock_file_stat[nlink]} == 1 && \
    $(( global_lock_descriptor_stat[mode] & 8#7777 )) == $(( 8#600 )) && \
    $(( global_lock_file_stat[mode] & 8#7777 )) == $(( 8#600 )) ]] || {
  print -u2 -- 'The stable global release lock changed while it was opened.'
  exit 1
}
if ! /usr/bin/lockf -s -t 0 ${global_lock_fd}; then
  print -u2 -- 'Another release operation holds the global release lock.'
  exit 75
fi
zstat -f ${global_lock_fd} -H global_lock_descriptor_stat
zstat -L -H global_lock_file_stat ${global_lock}
[[ ${global_lock_descriptor_stat[device]} == ${global_lock_file_stat[device]} && \
    ${global_lock_descriptor_stat[inode]} == ${global_lock_file_stat[inode]} && \
    ${global_lock_descriptor_stat[nlink]} == 1 && \
    ${global_lock_file_stat[nlink]} == 1 ]] || {
  print -u2 -- 'The stable global release lock changed during acquisition.'
  exit 1
}

typeset -r label=com.rsreberski.journald
typeset user_id
user_id=$(id -u)
typeset -r user_id
typeset -r service_target=gui/${user_id}/${label}
typeset -r plist=${HOME}/Library/LaunchAgents/${label}.plist
typeset -r config=${HOME}/.journal/config.json
typeset -r current_link=${HOME}/.journal/current-release
typeset -r expected_host=mickey-home.tail8a9beb.ts.net
typeset -r evidence_root=${context:A:h}
typeset stamp mode previous_release release manifest version staged_node archive
typeset base_commit manifest_sha256 archive_sha256
stamp=$(jq -er '.releaseStamp' ${context})
mode=$(jq -er '.mode' ${context})
previous_release=$(jq -er '.previousRelease' ${context})
release=$(jq -er '.releaseRoot' ${context})
manifest=$(jq -er '.manifest' ${context})
archive=$(jq -er '.archive' ${context})
base_commit=$(jq -er '.baseCommit' ${context})
manifest_sha256=$(jq -er '.manifestSha256' ${context})
archive_sha256=$(jq -er '.archiveSha256' ${context})
version=$(jq -er '.release.version' ${manifest})
staged_node=$(jq -er '.toolchain.nodePath' ${manifest})
typeset -r stamp mode previous_release release manifest version staged_node archive
typeset -r base_commit manifest_sha256 archive_sha256
typeset -r staged_cli=${release}/server/dist/cli.js
typeset -r transaction_helper=${release}/scripts/release-cutover-transaction.mjs
typeset -r deployed_tree_helper=${release}/scripts/release-deployed-tree.mjs
typeset -r serve_before=${evidence_root}/serve-before-${stamp}.json
typeset -r serve_after=${evidence_root}/serve-after-${stamp}.json
typeset -r serve_rollback_after=${evidence_root}/serve-rollback-after-${stamp}.json
typeset -r config_before=${evidence_root}/config-before-${stamp}.json
typeset -r plist_before=${evidence_root}/plist-before-${stamp}.plist
typeset -r config_next=${evidence_root}/config-next-${stamp}.json
typeset -r cutover_evidence=${evidence_root}/cutover-${stamp}.json
typeset -r rollback_evidence=${evidence_root}/rollback-${stamp}.json
typeset -r promotion_evidence=${evidence_root}/promotion-${stamp}.json
typeset -r promotion_prepared=${evidence_root}/promotion-prepared-${stamp}.json
typeset -r terminal_lock=${evidence_root}/terminal-${stamp}.lock
typeset -r transaction=${evidence_root}/cutover-transaction-${stamp}.json
typeset -r serve_recovery=${evidence_root}/serve-recovery-${stamp}.json
typeset -r deployed_tree_attestation=${evidence_root}/deployed-tree-${stamp}.json
typeset -r stamp_pattern='^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$'

[[ ${mode} == first-install || ${mode} == upgrade ]] || {
  print -u2 -- "Invalid release mode: ${mode}"
  exit 1
}
[[ ${stamp} =~ ${stamp_pattern} ]] || {
  print -u2 -- "Invalid release stamp: ${stamp}"
  exit 1
}
typeset actual_manifest_sha actual_archive_sha expected_cutover_sha actual_cutover_sha
typeset actual_node_version expected_node_version actual_node_path
actual_manifest_sha=$(shasum -a 256 ${manifest} | awk '{print $1}')
actual_archive_sha=$(shasum -a 256 ${archive} | awk '{print $1}')
[[ ${actual_manifest_sha} == ${manifest_sha256} ]] || {
  print -u2 -- 'Manifest hash no longer matches the release context.'
  exit 1
}
[[ ${actual_archive_sha} == ${archive_sha256} ]] || {
  print -u2 -- 'Archive hash no longer matches the release context.'
  exit 1
}
expected_cutover_sha=$(jq -er \
  '.files[] | select(.path == "scripts/release-cutover.zsh" and .kind == "file") | .sha256' \
  ${manifest})
actual_cutover_sha=$(shasum -a 256 ${0:A} | awk '{print $1}')
[[ ${actual_cutover_sha} == ${expected_cutover_sha} ]] || {
  print -u2 -- 'release-cutover.zsh changed after release attestation.'
  exit 1
}
[[ -d ${release} && ! -L ${release} && ${release:A} == ${HOME}/.journal/releases/${stamp} ]] || {
  print -u2 -- 'Staged release ownership or identity is invalid.'
  exit 1
}
actual_node_version=$(${staged_node} --version)
expected_node_version=$(jq -er '.toolchain.node' ${manifest})
actual_node_path=$(${staged_node} -p 'process.execPath')
[[ ${actual_node_version} == ${expected_node_version} && ${actual_node_path} == ${staged_node} ]] || {
  print -u2 -- 'Attested Node runtime is unavailable or has changed.'
  exit 1
}
${staged_node} ${release}/scripts/release-manifest.mjs --verify \
  ${manifest} ${release} --allow-extra node_modules --ignore-mode >/dev/null
[[ -x ${staged_node} && -f ${staged_cli} && -f ${transaction_helper} && \
    -f ${deployed_tree_helper} ]] || {
  print -u2 -- 'A staged release runtime helper is unavailable.'
  exit 1
}

function bounded_command {
  typeset -r journal_command_timeout=$1
  shift
  (( journal_command_timeout > 0.0 )) || return 124
  /usr/bin/perl -MTime::HiRes=alarm -e '
    my $timeout = shift @ARGV;
    alarm($timeout);
    exec { $ARGV[0] } @ARGV;
    die "exec failed: $!";
  ' ${journal_command_timeout} "$@"
}

function transaction_command {
  typeset -r journal_transaction_command=$1
  bounded_command 10 ${staged_node} ${transaction_helper} ${journal_transaction_command} \
    --transaction ${transaction} \
    --release-stamp ${stamp} \
    --mode ${mode} \
    --base-commit ${base_commit} \
    --manifest-sha256 ${manifest_sha256} \
    --archive-sha256 ${archive_sha256} \
    --release-root ${release} \
    --previous-release "${previous_release}" \
    --current-link ${current_link} \
    --config ${config} \
    --plist ${plist} \
    --service-target ${service_target} \
    --serve-before ${serve_before} \
    --config-before ${config_before} \
    --plist-before ${plist_before} \
    --config-next ${config_next} \
    --serve-after ${serve_after} \
    --serve-recovery ${serve_recovery} \
    --serve-rollback-after ${serve_rollback_after} \
    --cutover-evidence ${cutover_evidence} \
    --rollback-evidence ${rollback_evidence}
}

function verify_deployed_tree {
  bounded_command 30 ${staged_node} ${deployed_tree_helper} --verify \
    --context ${context} --root ${release} --attestation ${deployed_tree_attestation} >/dev/null
}

function write_json_atomically {
  typeset -r journal_json_target=$1
  bounded_command 10 ${staged_node} ${transaction_helper} write-json \
    --path ${journal_json_target}
}

function copy_private_atomically {
  typeset -r journal_copy_source=$1
  typeset -r journal_copy_target=$2
  bounded_command 10 ${staged_node} ${transaction_helper} copy-private \
    --source ${journal_copy_source} --target ${journal_copy_target}
}

function restore_private_atomically {
  typeset -r journal_restore_source=$1
  typeset -r journal_restore_target=$2
  bounded_command 10 ${staged_node} ${transaction_helper} restore-private \
    --source ${journal_restore_source} --target ${journal_restore_target}
}

function compare_private_files {
  typeset -r journal_expected_file=$1
  typeset -r journal_actual_file=$2
  bounded_command 10 ${staged_node} ${transaction_helper} compare-private \
    --expected ${journal_expected_file} --actual ${journal_actual_file}
}

function compare_upgrade_migrations {
  [[ ${mode} == upgrade ]] || return 0
  # This reversible path intentionally rejects every runtime-visible schema change.
  bounded_command 10 ${staged_node} ${transaction_helper} compare-migration-definitions \
    --candidate ${release}/server/dist/db/migrations.js \
    --previous ${previous_release}/server/dist/db/migrations.js
  bounded_command 10 ${staged_node} ${transaction_helper} compare-migrations \
    --candidate ${release}/server/dist/db/migrations \
    --previous ${previous_release}/server/dist/db/migrations
  bounded_command 10 ${staged_node} ${transaction_helper} compare-migrations \
    --candidate ${release}/server/src/db/migrations \
    --previous ${previous_release}/server/src/db/migrations
}

function remove_owned_evidence_paths {
  typeset -a journal_remove_arguments
  typeset journal_remove_file
  journal_remove_arguments=(remove-files --root ${evidence_root})
  for journal_remove_file in "$@"; do
    journal_remove_arguments+=(--path ${journal_remove_file})
  done
  bounded_command 10 ${staged_node} ${transaction_helper} \
    "${journal_remove_arguments[@]}"
}

function remove_owned_resource_path {
  typeset -r journal_resource_root=$1
  typeset -r journal_resource_file=$2
  bounded_command 10 ${staged_node} ${transaction_helper} remove-files \
    --root ${journal_resource_root} --path ${journal_resource_file}
}

function capture_serve_snapshot {
  typeset -r journal_serve_target=$1
  bounded_command 5 tailscale serve status --json | write_json_atomically ${journal_serve_target}
}

function record_global_lock {
  bounded_command 10 ${staged_node} ${transaction_helper} global-lock-record \
    --path ${global_lock} --fd ${global_lock_fd} --owner-pid $$ \
    --operation cutover-${action}
}

function read_terminal_marker {
  bounded_command 10 ${staged_node} ${transaction_helper} terminal-read \
    --path ${terminal_lock} --release-stamp ${stamp}
}

function write_terminal_marker {
  typeset -r journal_terminal_state=$1
  typeset -r journal_terminal_operation=$2
  bounded_command 10 ${staged_node} ${transaction_helper} terminal-write \
    --path ${terminal_lock} --release-stamp ${stamp} \
    --state ${journal_terminal_state} --operation ${journal_terminal_operation} \
    --owner-pid $$
}

function remove_apply_terminal_marker {
  bounded_command 10 ${staged_node} ${transaction_helper} terminal-remove \
    --path ${terminal_lock} --release-stamp ${stamp} \
    --expected-state in-progress --expected-operation cutover-apply
}

function provisional_apply_state_exists {
  typeset journal_provisional_file
  for journal_provisional_file in \
    ${serve_before} ${serve_before}.next \
    ${serve_after} ${serve_after}.next \
    ${serve_recovery} ${serve_recovery}.next \
    ${config_before} ${config_before}.next \
    ${plist_before} ${plist_before}.next \
    ${config_next} ${config_next}.next \
    ${transaction}.next ${cutover_evidence}.next; do
    [[ -e ${journal_provisional_file} || -L ${journal_provisional_file} ]] && return 0
  done
  return 1
}

function listener_rows {
  typeset -r journal_lsof_timeout=${1:-2}
  typeset journal_lsof_output journal_lsof_exit
  if journal_lsof_output=$(bounded_command ${journal_lsof_timeout} \
    /usr/sbin/lsof -nP -iTCP:5178 -sTCP:LISTEN -Fpn 2>/dev/null); then
    journal_lsof_exit=0
  else
    journal_lsof_exit=$?
  fi
  (( journal_lsof_exit == 0 || journal_lsof_exit == 1 )) || {
    print -u2 -- "lsof failed with status ${journal_lsof_exit}."
    return 1
  }
  print -r -- ${journal_lsof_output}
}

function launchd_listener_rows {
  typeset -r journal_lsof_timeout=${1:-2}
  typeset -r journal_launchd_pid=${2:?launchd PID is required}
  typeset journal_lsof_output journal_lsof_exit
  [[ ${journal_launchd_pid} == <-> ]] && (( journal_launchd_pid > 0 )) || {
    print -u2 -- 'The launchd listener query requires a positive PID.'
    return 1
  }
  if journal_lsof_output=$(bounded_command ${journal_lsof_timeout} \
    /usr/sbin/lsof -nP -a -p ${journal_launchd_pid} \
      -iTCP:5178 -sTCP:LISTEN -Fpn 2>/dev/null); then
    journal_lsof_exit=0
  else
    journal_lsof_exit=$?
  fi
  (( journal_lsof_exit == 0 || journal_lsof_exit == 1 )) || {
    print -u2 -- "lsof failed with status ${journal_lsof_exit}."
    return 1
  }
  print -r -- ${journal_lsof_output}
}

function assert_current_pointer {
  if [[ ${mode} == upgrade ]]; then
    [[ -L ${current_link} && ${current_link:A} == ${previous_release:A} ]] || {
      print -u2 -- 'Upgrade no longer owns the expected current-release pointer.'
      return 1
    }
  else
    [[ ! -e ${current_link} && ! -L ${current_link} ]] || {
      print -u2 -- 'First install requires current-release to remain absent.'
      return 1
    }
  fi
}

# Upgrade ownership must be able to adopt the legacy direct Node argv once, while all newly
# installed candidates use /usr/bin/env -i. Both shapes still identify the exact previous CLI and
# an absolute executable Node path; the candidate verifier remains strict about the isolated shape.
function parse_previous_program {
  typeset -r arguments_json=${1}
  typeset -r expected_cli=${2}
  typeset -r environment_json=${3}
  print -r -- "${arguments_json}" | jq -er \
    --arg cli "${expected_cli}" --argjson environment "${environment_json}" '
    if length == 3 and (.[0] | startswith("/")) and .[1] == $cli and .[2] == "serve" then
      [.[0], .[1]] | @tsv
    elif length >= 6 and .[0] == "/usr/bin/env" and .[1] == "-i" and
      (.[-3] | startswith("/")) and .[-2] == $cli and .[-1] == "serve" and
      (.[2:-3] | length > 0 and all(.[]; test("^[A-Z][A-Z0-9_]*=.*$"))) and
      ((.[2:-3] | sort) ==
        ($environment | to_entries | map("\(.key)=\(.value)") | sort)) then
      [.[-3], .[-2]] | @tsv
    else
      error("previous ProgramArguments are not an owned Journal serve command")
    end'
}

function assert_upgrade_runtime {
  typeset -r validation_timeout=${1:-12.0}
  typeset -r validation_deadline=$(( EPOCHREALTIME + validation_timeout ))
  typeset pid arguments environment working_directory previous_node previous_cli previous_program
  typeset launch_output loaded_working_directory cwd_rows process_working_directory
  typeset final_launch_output final_pid final_loaded_working_directory
  typeset rows pid_count name_count listener_count validation_remaining
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  launch_output=$(bounded_command ${validation_remaining} /bin/launchctl print ${service_target}) || return 1
  pid=$(print -r -- ${launch_output} | awk '
    /^[[:space:]]*pid = [0-9]+[[:space:]]*$/ { count += 1; pid = $3 }
    END { if (count != 1 || pid < 1) exit 1; print pid }
  ') || return 1
  loaded_working_directory=$(print -r -- ${launch_output} | awk '
    /^[[:space:]]*working directory = \/.*$/ {
      count += 1
      sub(/^[[:space:]]*working directory = /, "")
      directory = $0
    }
    END { if (count != 1 || directory == "") exit 1; print directory }
  ') || return 1
  [[ ${loaded_working_directory} == ${previous_release} ]] || {
    print -u2 -- 'Loaded upgrade service working directory does not match the previous release.'
    return 1
  }
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  arguments=$(bounded_command ${validation_remaining} \
    /usr/bin/plutil -extract ProgramArguments json -o - ${plist}) || return 1
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  environment=$(bounded_command ${validation_remaining} \
    /usr/bin/plutil -extract EnvironmentVariables json -o - ${plist}) || return 1
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  working_directory=$(bounded_command ${validation_remaining} \
    /usr/bin/plutil -extract WorkingDirectory raw -o - ${plist}) || return 1
  [[ ${working_directory} == ${previous_release} ]] || {
    print -u2 -- 'Upgrade plist working directory does not match the previous release.'
    return 1
  }
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  previous_program=$(parse_previous_program \
    "${arguments}" "${previous_release}/server/dist/cli.js" "${environment}") || return 1
  previous_node=${previous_program%%$'\t'*}
  previous_cli=${previous_program#*$'\t'}
  [[ -f ${previous_node} && -x ${previous_node} && -f ${previous_cli} && -x ${previous_cli} ]] || {
    print -u2 -- 'Previous Node or CLI executable is unavailable; rollback would be impossible.'
    return 1
  }
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  print -r -- ${environment} | bounded_command ${validation_remaining} jq -e \
    --arg config "${config}" \
    --arg dataDir "${HOME}/.journal" \
    '.JOURNAL_CONFIG == $config and .JOURNAL_DATA_DIR == $dataDir' >/dev/null || return 1
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  bounded_command ${validation_remaining} jq -e \
    --arg dataDir "${HOME}/.journal" \
    '.port == 5178 and .bindHost == "127.0.0.1" and .dataDir == $dataDir and
      .hostAllowlist == ["localhost:5178", "127.0.0.1:5178", "mickey-home.tail8a9beb.ts.net:5178"] and
      .tailnetHostname == "mickey-home.tail8a9beb.ts.net:5178" and
      .timezone == "Europe/Amsterdam" and .dayBoundaryOffsetMin == 0' \
    ${config} >/dev/null || return 1
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  previous_version=$(print -r -- ${environment} | \
    bounded_command ${validation_remaining} jq -er '.JOURNAL_VERSION') || return 1
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  (( validation_remaining > 0.0 )) || return 1
  bounded_command ${validation_remaining} curl \
    --fail --silent --show-error --max-time ${validation_remaining} \
    http://127.0.0.1:5178/healthz | \
    bounded_command ${validation_remaining} jq -e --arg version "${previous_version}" \
      '.status == "ok" and .db == "ok" and .version == $version' >/dev/null || return 1
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  rows=$(launchd_listener_rows ${validation_remaining} ${pid}) || return 1
  pid_count=$(print -r -- ${rows} | awk -v expected=${pid} '$0 == "p" expected { count++ } END { print count + 0 }') || return 1
  name_count=$(print -r -- ${rows} | awk '$0 == "n127.0.0.1:5178" { count++ } END { print count + 0 }') || return 1
  listener_count=$(print -r -- ${rows} | awk '/^n/ { count++ } END { print count + 0 }') || return 1
  [[ ${pid_count} == 1 && ${name_count} == 1 && ${listener_count} == 1 ]] || {
    print -u2 -- 'Upgrade does not own exactly one launchd PID on loopback :5178.'
    return 1
  }
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  cwd_rows=$(bounded_command ${validation_remaining} \
    /usr/sbin/lsof -nP -a -p ${pid} -d cwd -Fn) || return 1
  process_working_directory=$(print -r -- ${cwd_rows} | awk -v expected_pid=${pid} '
    /^p[0-9]+$/ { pid = substr($0, 2); descriptor = "" }
    /^fcwd$/ { descriptor = "cwd"; next }
    /^n\// && descriptor == "cwd" { count += 1; directory = substr($0, 2) }
    END {
      if (count != 1 || pid != expected_pid || directory == "") exit 1
      print directory
    }
  ') || return 1
  [[ ${process_working_directory} == ${previous_release} && \
      ${process_working_directory:A} == ${previous_release:A} ]] || {
    print -u2 -- 'Upgrade service PID cwd does not match the previous release.'
    return 1
  }
  validation_remaining=$(( validation_deadline - EPOCHREALTIME ))
  final_launch_output=$(bounded_command ${validation_remaining} \
    /bin/launchctl print ${service_target}) || return 1
  final_pid=$(print -r -- ${final_launch_output} | awk '
    /^[[:space:]]*pid = [0-9]+[[:space:]]*$/ { count += 1; pid = $3 }
    END { if (count != 1 || pid < 1) exit 1; print pid }
  ') || return 1
  final_loaded_working_directory=$(print -r -- ${final_launch_output} | awk '
    /^[[:space:]]*working directory = \/.*$/ {
      count += 1
      sub(/^[[:space:]]*working directory = /, "")
      directory = $0
    }
    END { if (count != 1 || directory == "") exit 1; print directory }
  ') || return 1
  [[ ${final_pid} == ${pid} && \
      ${final_loaded_working_directory} == ${loaded_working_directory} ]] || {
    print -u2 -- 'Upgrade launchd PID or working directory changed during preflight.'
    return 1
  }
}

function wait_upgrade_runtime {
  typeset -r journal_total_timeout=${1:-15.0}
  typeset -r journal_max_attempt_timeout=${2:-12.0}
  typeset -r journal_readiness_deadline=$(( EPOCHREALTIME + journal_total_timeout ))
  typeset journal_readiness_remaining journal_attempt_timeout journal_sleep
  while (( EPOCHREALTIME < journal_readiness_deadline )); do
    journal_readiness_remaining=$(( journal_readiness_deadline - EPOCHREALTIME ))
    journal_attempt_timeout=$(( journal_readiness_remaining < journal_max_attempt_timeout ? journal_readiness_remaining : journal_max_attempt_timeout ))
    if assert_upgrade_runtime ${journal_attempt_timeout} >/dev/null 2>&1; then
      return 0
    fi
    journal_readiness_remaining=$(( journal_readiness_deadline - EPOCHREALTIME ))
    (( journal_readiness_remaining > 0.0 )) || break
    journal_sleep=$(( journal_readiness_remaining < 0.1 ? journal_readiness_remaining : 0.1 ))
    sleep ${journal_sleep}
  done
  print -u2 -- 'Previous launchd service did not become ready within 15 seconds.'
  return 1
}

function wait_no_listener {
  typeset -r journal_listener_timeout=${1:-5.0}
  typeset -r journal_listener_deadline=$(( EPOCHREALTIME + journal_listener_timeout ))
  typeset journal_listener_rows journal_listener_remaining journal_listener_sleep
  while (( EPOCHREALTIME < journal_listener_deadline )); do
    journal_listener_remaining=$(( journal_listener_deadline - EPOCHREALTIME ))
    journal_listener_rows=$(listener_rows ${journal_listener_remaining}) || return 1
    [[ -z ${journal_listener_rows} ]] && return 0
    journal_listener_remaining=$(( journal_listener_deadline - EPOCHREALTIME ))
    (( journal_listener_remaining > 0.0 )) || break
    journal_listener_sleep=$(( journal_listener_remaining < 0.1 ? journal_listener_remaining : 0.1 ))
    sleep ${journal_listener_sleep}
  done
  print -u2 -- 'Journal listener did not stop within five seconds.'
  return 1
}

function assert_launchctl_job_absent {
  typeset -r journal_launch_exit=$1
  typeset -r journal_launch_output=${2:-}
  if (( journal_launch_exit == 0 )); then
    print -u2 -- 'First install found an already-loaded Journal service.'
    return 1
  fi
  (( journal_launch_exit == 3 || journal_launch_exit == 113 )) || {
    print -u2 -- "launchctl print failed with status ${journal_launch_exit}: ${journal_launch_output}"
    return 1
  }
}

function assert_first_install_absent {
  typeset journal_existing_rows journal_launch_output journal_launch_exit
  [[ ! -e ${plist} && ! -L ${plist} && ! -e ${config} && ! -L ${config} ]] || {
    print -u2 -- 'First install found an existing plist or config; ownership is ambiguous.'
    return 1
  }
  if journal_launch_output=$(bounded_command 2 /bin/launchctl print ${service_target} 2>&1); then
    journal_launch_exit=0
  else
    journal_launch_exit=$?
  fi
  assert_launchctl_job_absent ${journal_launch_exit} "${journal_launch_output}" || return 1
  journal_existing_rows=$(listener_rows 2) || return 1
  [[ -z ${journal_existing_rows} ]] || {
    print -u2 -- 'First install found an existing :5178 listener.'
    return 1
  }
}

function wait_launchctl_job_absent {
  typeset -r journal_absence_timeout=${1:-5.0}
  typeset -r journal_absence_deadline=$(( EPOCHREALTIME + journal_absence_timeout ))
  typeset journal_absence_output journal_absence_exit journal_absence_remaining
  typeset journal_absence_sleep
  typeset -i journal_stable_absence_count=0
  while (( EPOCHREALTIME < journal_absence_deadline )); do
    journal_absence_remaining=$(( journal_absence_deadline - EPOCHREALTIME ))
    if journal_absence_output=$(bounded_command ${journal_absence_remaining} \
      /bin/launchctl print ${service_target} 2>&1); then
      journal_absence_exit=0
    else
      journal_absence_exit=$?
    fi
    if (( journal_absence_exit == 3 || journal_absence_exit == 113 )); then
      (( journal_stable_absence_count += 1 ))
      (( journal_stable_absence_count >= 2 )) && return 0
    elif (( journal_absence_exit == 0 )); then
      journal_stable_absence_count=0
    else
      print -u2 -- \
        "launchctl absence check failed with status ${journal_absence_exit}: ${journal_absence_output}"
      return 1
    fi
    journal_absence_remaining=$(( journal_absence_deadline - EPOCHREALTIME ))
    (( journal_absence_remaining > 0.0 )) || break
    journal_absence_sleep=$(( journal_absence_remaining < 0.1 ? journal_absence_remaining : 0.1 ))
    sleep ${journal_absence_sleep}
  done
  print -u2 -- 'Journal launchd job did not become stably absent within five seconds.'
  return 1
}

function bootout_owned_service {
  typeset journal_bootout_output journal_bootout_exit
  if journal_bootout_output=$(bounded_command 5 /bin/launchctl bootout ${service_target} 2>&1); then
    journal_bootout_exit=0
  else
    journal_bootout_exit=$?
  fi
  (( journal_bootout_exit == 0 || journal_bootout_exit == 3 || journal_bootout_exit == 113 )) || {
    print -u2 -- "launchctl bootout failed with status ${journal_bootout_exit}: ${journal_bootout_output}"
    return 1
  }
  wait_launchctl_job_absent 5.0
}

function assert_owner_private_file {
  typeset -r journal_evidence_file=$1
  typeset journal_evidence_mode
  [[ -f ${journal_evidence_file} && ! -L ${journal_evidence_file} && -O ${journal_evidence_file} ]] || {
    print -u2 -- "Private release file is missing, linked, or not owner-controlled: ${journal_evidence_file}"
    return 1
  }
  journal_evidence_mode=$(/usr/bin/stat -f '%Lp' ${journal_evidence_file}) || return 1
  [[ ${journal_evidence_mode} == 600 ]] || {
    print -u2 -- "Private release file is not mode 0600: ${journal_evidence_file}"
    return 1
  }
}

function validate_rollback_evidence {
  typeset journal_baseline_json journal_recomputed_json journal_recorded_json
  typeset journal_recomputed_canonical journal_recorded_canonical
  typeset journal_previous_arguments journal_previous_environment journal_previous_working_directory
  typeset journal_previous_node journal_previous_cli
  assert_owner_private_file ${serve_before} || return 1
  assert_owner_private_file ${serve_after} || return 1
  assert_owner_private_file ${cutover_evidence} || return 1
  jq -e \
    --arg stamp "${stamp}" \
    --arg mode "${mode}" \
    --arg baseCommit "${base_commit}" \
    --arg manifestSha256 "${manifest_sha256}" \
    --arg archiveSha256 "${archive_sha256}" \
    '.schemaVersion == 1 and .releaseStamp == $stamp and .mode == $mode and
      .baseCommit == $baseCommit and .manifestSha256 == $manifestSha256 and
      .archiveSha256 == $archiveSha256 and .currentReleaseUnchanged == true' \
    ${cutover_evidence} >/dev/null || return 1
  journal_baseline_json=$(bounded_command 5 \
    ${staged_node} ${release}/scripts/release-serve-config.mjs \
    --before ${serve_before} --after ${serve_before} --mode ${mode} --baseline) || return 1
  [[ -n ${journal_baseline_json} ]] || return 1
  journal_recomputed_json=$(bounded_command 5 \
    ${staged_node} ${release}/scripts/release-serve-config.mjs \
    --before ${serve_before} --after ${serve_after} --mode ${mode}) || return 1
  journal_recorded_json=$(jq -ce '.tailscale' ${cutover_evidence}) || return 1
  journal_recomputed_canonical=$(print -r -- ${journal_recomputed_json} | jq -cS .) || return 1
  journal_recorded_canonical=$(print -r -- ${journal_recorded_json} | jq -cS .) || return 1
  [[ ${journal_recomputed_canonical} == ${journal_recorded_canonical} ]] || {
    print -u2 -- 'Cutover Serve summary contradicts the raw rollback snapshots.'
    return 1
  }

  if [[ ${mode} == upgrade ]]; then
    assert_owner_private_file ${config_before} || return 1
    assert_owner_private_file ${plist_before} || return 1
    jq -e \
      --arg dataDir "${HOME}/.journal" \
      '.port == 5178 and .bindHost == "127.0.0.1" and .dataDir == $dataDir and
        .hostAllowlist == ["localhost:5178", "127.0.0.1:5178", "mickey-home.tail8a9beb.ts.net:5178"] and
        .tailnetHostname == "mickey-home.tail8a9beb.ts.net:5178" and
        .timezone == "Europe/Amsterdam" and .dayBoundaryOffsetMin == 0' \
      ${config_before} >/dev/null || return 1
    /usr/bin/plutil -lint ${plist_before} >/dev/null || return 1
    journal_previous_arguments=$(/usr/bin/plutil -extract ProgramArguments json -o - ${plist_before}) || return 1
    journal_previous_environment=$(/usr/bin/plutil -extract EnvironmentVariables json -o - ${plist_before}) || return 1
    journal_previous_working_directory=$(/usr/bin/plutil -extract WorkingDirectory raw -o - ${plist_before}) || return 1
    [[ ${journal_previous_working_directory} == ${previous_release} ]] || {
      print -u2 -- 'Rollback plist working directory does not match the previous release.'
      return 1
    }
    typeset journal_previous_program
    journal_previous_program=$(parse_previous_program \
      "${journal_previous_arguments}" "${previous_release}/server/dist/cli.js" \
      "${journal_previous_environment}") || return 1
    journal_previous_node=${journal_previous_program%%$'\t'*}
    journal_previous_cli=${journal_previous_program#*$'\t'}
    [[ -f ${journal_previous_node} && -x ${journal_previous_node} && \
        -f ${journal_previous_cli} && -x ${journal_previous_cli} ]] || {
      print -u2 -- 'Upgrade rollback Node or CLI executable is unavailable.'
      return 1
    }
    print -r -- ${journal_previous_environment} | jq -e \
      --arg config "${config}" \
      --arg dataDir "${HOME}/.journal" \
      '.JOURNAL_CONFIG == $config and .JOURNAL_DATA_DIR == $dataDir and
        (.JOURNAL_VERSION | type == "string" and length > 0)' >/dev/null || return 1
  fi
}

function cleanup_recovery_snapshot {
  remove_owned_evidence_paths ${serve_recovery} ${serve_recovery}.next
}

function restore_baseline_resources {
  typeset -r journal_restored_serve=$1
  typeset journal_off_output journal_off_exit journal_restored_json
  journal_off_exit=-1
  assert_current_pointer || return 1
  if [[ ${mode} == upgrade ]]; then
    [[ -f ${config_before} && -f ${plist_before} ]] || {
      print -u2 -- 'Upgrade rollback snapshots are missing.'
      return 1
    }
    bootout_owned_service || return 1
    remove_owned_resource_path ${HOME}/.journal ${config}.next || return 1
    remove_owned_resource_path ${HOME}/Library/LaunchAgents ${plist}.next || return 1
    restore_private_atomically ${config_before} ${config} || return 1
    restore_private_atomically ${plist_before} ${plist} || return 1
    bounded_command 5 /bin/launchctl bootstrap gui/${user_id} ${plist} || return 1
    wait_upgrade_runtime || return 1
    compare_private_files ${config_before} ${config} || return 1
    compare_private_files ${plist_before} ${plist} || return 1
  else
    if journal_off_output=$(bounded_command 10 \
      tailscale serve --https=5178 off 2>&1); then
      journal_off_exit=0
    else
      journal_off_exit=$?
    fi
    bootout_owned_service || return 1
    [[ ${plist:A} == ${HOME}/Library/LaunchAgents/${label}.plist ]] || return 1
    remove_owned_resource_path ${HOME}/Library/LaunchAgents ${plist}.next || return 1
    remove_owned_resource_path ${HOME}/Library/LaunchAgents ${plist} || return 1
    [[ ${config:A} == ${HOME}/.journal/config.json ]] || return 1
    remove_owned_resource_path ${HOME}/.journal ${config}.next || return 1
    remove_owned_resource_path ${HOME}/.journal ${config} || return 1
    wait_no_listener || return 1
    assert_first_install_absent || return 1
  fi
  assert_current_pointer || return 1
  remove_owned_evidence_paths ${journal_restored_serve} ${journal_restored_serve}.next || return 1
  capture_serve_snapshot ${journal_restored_serve} || return 1
  journal_restored_json=$(bounded_command 5 \
    ${staged_node} ${release}/scripts/release-serve-config.mjs \
    --before ${serve_before} --after ${journal_restored_serve} --mode ${mode} --rollback) || return 1
  assert_current_pointer || return 1
  print -r -- ${journal_restored_json} | jq -c \
    --argjson tailscaleOffExit "${journal_off_exit}" \
    '. + {tailscaleOffExit: (if $tailscaleOffExit < 0 then null else $tailscaleOffExit end)}'
}

function prove_unmutated_baseline {
  assert_current_pointer || return 1
  if [[ ${mode} == upgrade ]]; then
    assert_owner_private_file ${config} || return 1
    assert_owner_private_file ${plist} || return 1
    assert_upgrade_runtime 12.0 || return 1
    if [[ -e ${config_before} ]]; then
      compare_private_files ${config_before} ${config} || return 1
    fi
    if [[ -e ${plist_before} ]]; then
      compare_private_files ${plist_before} ${plist} || return 1
    fi
  else
    assert_first_install_absent || return 1
  fi
  cleanup_recovery_snapshot || return 1
  capture_serve_snapshot ${serve_recovery} || return 1
  if [[ -e ${serve_before} ]]; then
    assert_owner_private_file ${serve_before} || return 1
    bounded_command 5 ${staged_node} ${release}/scripts/release-serve-config.mjs \
      --before ${serve_before} --after ${serve_recovery} --mode ${mode} --rollback >/dev/null || \
      return 1
  else
    bounded_command 5 ${staged_node} ${release}/scripts/release-serve-config.mjs \
      --before ${serve_recovery} --after ${serve_recovery} --mode ${mode} --baseline >/dev/null || \
      return 1
  fi
  assert_current_pointer
}

function verify_committed_cutover_live {
  typeset journal_live_runtime journal_live_tailnet
  validate_rollback_evidence || return 1
  assert_current_pointer || return 1
  verify_deployed_tree || return 1
  journal_live_runtime=$(bounded_command 35 \
    ${staged_node} ${release}/scripts/release-verify-runtime.mjs \
    --release ${release} --manifest ${manifest} --node ${staged_node} \
    --timeout-ms 30000) || return 1
  [[ -n ${journal_live_runtime} ]] || return 1
  cleanup_recovery_snapshot || return 1
  capture_serve_snapshot ${serve_recovery} || return 1
  bounded_command 5 ${staged_node} ${release}/scripts/release-serve-config.mjs \
    --before ${serve_after} --after ${serve_recovery} --mode upgrade >/dev/null || return 1
  journal_live_tailnet=$(bounded_command 20 \
    ${staged_node} ${release}/scripts/release-verify-runtime.mjs \
    --origin-only \
    --origin https://mickey-home.tail8a9beb.ts.net:5178 \
    --manifest ${manifest} \
    --timeout-ms 15000) || return 1
  [[ -n ${journal_live_tailnet} ]] || return 1
  cleanup_recovery_snapshot || return 1
  assert_current_pointer
}

function validate_committed_rollback {
  typeset journal_expected_rollback journal_recorded_rollback
  validate_rollback_evidence || return 1
  assert_owner_private_file ${serve_rollback_after} || return 1
  assert_owner_private_file ${rollback_evidence} || return 1
  journal_expected_rollback=$(bounded_command 5 \
    ${staged_node} ${release}/scripts/release-serve-config.mjs \
    --before ${serve_before} --after ${serve_rollback_after} --mode ${mode} --rollback) || return 1
  journal_recorded_rollback=$(jq -cS 'del(.tailscaleOffExit)' ${rollback_evidence}) || return 1
  [[ $(print -r -- ${journal_expected_rollback} | jq -cS .) == ${journal_recorded_rollback} ]] || {
    print -u2 -- 'Rollback evidence contradicts its raw Serve snapshot.'
    return 1
  }
  jq -e '
    has("tailscaleOffExit") and
    (.tailscaleOffExit == null or
      (.tailscaleOffExit | type == "number" and floor == . and . >= 0))
  ' ${rollback_evidence} >/dev/null || return 1
}

function validate_committed_promotion_terminal {
  assert_owner_private_file ${promotion_evidence} || return 1
  jq -e \
    --arg stamp "${stamp}" \
    --arg baseCommit "${base_commit}" \
    --arg manifestSha256 "${manifest_sha256}" \
    --arg archiveSha256 "${archive_sha256}" \
    --arg release "${release}" \
    '.schemaVersion == 1 and .releaseStamp == $stamp and
      .baseCommit == $baseCommit and .manifestSha256 == $manifestSha256 and
      .archiveSha256 == $archiveSha256 and .currentRelease == $release' \
    ${promotion_evidence} >/dev/null || return 1
  [[ -L ${current_link} && ${current_link:A} == ${release:A} ]] || {
    print -u2 -- 'Promotion evidence does not match the current-release pointer.'
    return 1
  }
}

function cleanup_uncommitted_transaction {
  remove_owned_evidence_paths \
    ${config_next} ${config_next}.next \
    ${serve_after} ${serve_after}.next \
    ${serve_recovery} ${serve_recovery}.next \
    ${serve_rollback_after} ${serve_rollback_after}.next \
    ${cutover_evidence}.next || return 1
  remove_owned_evidence_paths ${transaction}.next ${transaction} || return 1
  remove_owned_evidence_paths \
    ${serve_before} ${serve_before}.next \
    ${config_before} ${config_before}.next \
    ${plist_before} ${plist_before}.next
}

function cleanup_pretransaction_provisional {
  remove_owned_evidence_paths \
    ${serve_before} ${serve_before}.next \
    ${serve_after} ${serve_after}.next \
    ${serve_recovery} ${serve_recovery}.next \
    ${serve_rollback_after} ${serve_rollback_after}.next \
    ${config_before} ${config_before}.next \
    ${plist_before} ${plist_before}.next \
    ${config_next} ${config_next}.next \
    ${transaction}.next ${cutover_evidence}.next
}

function cleanup_committed_transaction {
  remove_owned_evidence_paths \
    ${config_next} ${config_next}.next \
    ${serve_recovery} ${serve_recovery}.next \
    ${transaction}.next || return 1
  remove_owned_evidence_paths ${transaction}
}

typeset cutover_transaction_active=0
typeset cutover_committed=0

function release_all_locks {
  typeset journal_release_failed=0
  if (( global_lock_fd >= 0 )); then
    if ! bounded_command 10 ${staged_node} ${transaction_helper} global-lock-verify \
        --path ${global_lock} \
        --fd ${global_lock_fd}; then
      journal_release_failed=1
    fi
    exec {global_lock_fd}>&- || journal_release_failed=1
    global_lock_fd=-1
  fi
  return ${journal_release_failed}
}

function cutover_exit_handler {
  typeset journal_cutover_exit=$?
  typeset journal_restore_exit=0
  trap - EXIT HUP INT TERM
  unsetopt ERR_EXIT
  if (( journal_cutover_exit != 0 && cutover_committed == 0 )) && \
      [[ ! -e ${cutover_evidence} ]] && \
      { (( cutover_transaction_active == 1 )) || [[ -e ${transaction} ]]; }; then
    print -u2 -- 'Cutover failed; restoring the durable pre-cutover transaction.'
    if transaction_command transaction-validate && verify_deployed_tree && \
        restore_baseline_resources ${serve_recovery} >/dev/null && \
        cleanup_uncommitted_transaction && remove_apply_terminal_marker; then
      cutover_transaction_active=0
    else
      journal_restore_exit=1
      print -u2 -- 'Automatic restore did not complete; retry apply to resume it safely.'
    fi
  fi
  if ! release_all_locks; then
    journal_restore_exit=1
  fi
  (( journal_restore_exit == 0 )) || journal_cutover_exit=1
  exit ${journal_cutover_exit}
}

record_global_lock
trap cutover_exit_handler EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

verify_deployed_tree
compare_upgrade_migrations
remove_owned_evidence_paths ${terminal_lock}.next
typeset terminal_json terminal_state terminal_operation
terminal_json=$(read_terminal_marker)
terminal_state=$(print -r -- ${terminal_json} | jq -er '.state')
terminal_operation=$(print -r -- ${terminal_json} | jq -er '.operation // ""')

if [[ -e ${promotion_evidence} ]]; then
  validate_committed_promotion_terminal
  if [[ ${terminal_state} == in-progress && ${terminal_operation} == promotion ]]; then
    write_terminal_marker promotion-complete promotion
  elif [[ ${terminal_state} != promotion-complete || ${terminal_operation} != promotion ]]; then
    print -u2 -- 'Promotion evidence conflicts with the per-context terminal marker.'
    exit 1
  fi
  print -u2 -- 'This release context has already been promoted and is terminal.'
  exit 1
fi
if [[ ${terminal_state} == promotion-complete ]]; then
  print -u2 -- 'The terminal marker claims promotion without final promotion evidence.'
  exit 1
fi
if [[ ${terminal_state} == in-progress && ${terminal_operation} == promotion ]]; then
  if [[ -e ${promotion_prepared} ]]; then
    print -u2 -- 'An interrupted promotion transaction must be resumed with release-promote.'
  else
    print -u2 -- 'Interrupted promotion ownership is missing its prepared or final evidence.'
  fi
  exit 1
fi

if [[ ${terminal_state} == in-progress && ${terminal_operation} == cutover-apply ]]; then
  if [[ -e ${cutover_evidence} ]]; then
    [[ -e ${serve_before} && -e ${serve_after} ]] || {
      print -u2 -- 'Committed cutover evidence is missing its durable Serve snapshots.'
      exit 1
    }
    if [[ -e ${transaction} ]]; then
      transaction_command transaction-validate
    fi
    if [[ ${action} == rollback ]]; then
      validate_rollback_evidence
    else
      verify_committed_cutover_live
      if [[ -e ${transaction} ]]; then
        cleanup_committed_transaction
      fi
    fi
    write_terminal_marker cutover-complete cutover-apply
    terminal_state=cutover-complete
    cutover_committed=1
  else
    if [[ -e ${transaction} ]]; then
      transaction_command transaction-validate
      restore_baseline_resources ${serve_recovery} >/dev/null
      cleanup_uncommitted_transaction
    elif provisional_apply_state_exists; then
      prove_unmutated_baseline
      cleanup_pretransaction_provisional
    else
      prove_unmutated_baseline
      cleanup_recovery_snapshot
    fi
    remove_apply_terminal_marker
    terminal_state=absent
    terminal_operation=''
  fi
elif [[ ${terminal_state} == cutover-complete ]]; then
  [[ ${terminal_operation} == cutover-apply && -e ${cutover_evidence} ]] || {
    print -u2 -- 'Cutover-complete terminal state is inconsistent with final evidence.'
    exit 1
  }
  if [[ ${action} == rollback ]]; then
    validate_rollback_evidence
  else
    verify_committed_cutover_live
    if [[ -e ${transaction} ]]; then
      transaction_command transaction-validate
      cleanup_committed_transaction
    fi
  fi
elif [[ ${terminal_state} == rollback-complete ]]; then
  [[ ${terminal_operation} == cutover-rollback && -e ${rollback_evidence} ]] || {
    print -u2 -- 'Rollback-complete terminal state is inconsistent with final evidence.'
    exit 1
  }
elif [[ ${terminal_state} == in-progress && ${terminal_operation} == cutover-rollback ]]; then
  [[ -e ${cutover_evidence} && -e ${serve_before} ]] || {
    print -u2 -- 'Interrupted rollback is missing successful cutover ownership evidence.'
    exit 1
  }
elif [[ ${terminal_state} != absent ]]; then
  print -u2 -- 'The per-context terminal marker has an unsupported state transition.'
  exit 1
fi

typeset rollback_resumed_during_apply=0
if [[ ${action} == rollback || \
    (${terminal_state} == in-progress && ${terminal_operation} == cutover-rollback) ]]; then
  [[ ${action} == rollback ]] || rollback_resumed_during_apply=1
  if [[ ${terminal_state} == rollback-complete ]]; then
    [[ -e ${serve_rollback_after} ]] || {
      print -u2 -- 'Final rollback evidence is missing its raw Serve snapshot.'
      exit 1
    }
    validate_committed_rollback
    prove_unmutated_baseline
    cleanup_recovery_snapshot
    print -- ${rollback_evidence}
    exit 0
  fi
  [[ ${terminal_state} == cutover-complete || \
      (${terminal_state} == in-progress && ${terminal_operation} == cutover-rollback) ]] || {
    print -u2 -- 'Rollback requires cutover-complete terminal ownership.'
    exit 1
  }
  assert_current_pointer
  [[ -f ${serve_before} && -f ${cutover_evidence} ]] || {
    print -u2 -- 'Successful cutover evidence or the pre-cutover Serve snapshot is missing.'
    exit 1
  }
  validate_rollback_evidence
  if [[ ${terminal_state} == cutover-complete ]]; then
    write_terminal_marker in-progress cutover-rollback
    terminal_state=in-progress
    terminal_operation=cutover-rollback
  fi
  if [[ -e ${rollback_evidence} ]]; then
    [[ -e ${serve_rollback_after} ]] || {
      print -u2 -- 'Final rollback evidence is missing its raw Serve snapshot.'
      exit 1
    }
    validate_committed_rollback
    prove_unmutated_baseline
    cleanup_recovery_snapshot
  else
    if [[ -e ${transaction} ]]; then
      transaction_command transaction-validate
    fi
    verify_deployed_tree
    assert_current_pointer
    remove_owned_evidence_paths ${serve_rollback_after} ${serve_rollback_after}.next \
      ${rollback_evidence}.next
    typeset rollback_json
    rollback_json=$(restore_baseline_resources ${serve_rollback_after})
    print -r -- ${rollback_json} | write_json_atomically ${rollback_evidence}
    validate_committed_rollback
  fi
  if [[ -e ${transaction} ]]; then
    cleanup_committed_transaction
  fi
  write_terminal_marker rollback-complete cutover-rollback
  if (( rollback_resumed_during_apply == 1 )); then
    print -u2 -- "Recovered interrupted rollback to terminal evidence: ${rollback_evidence}"
    exit 1
  fi
  print -- ${rollback_evidence}
  exit 0
fi

[[ ${action} == apply ]] || {
  print -u2 -- 'Rollback did not find cutover ownership to restore.'
  exit 1
}
if [[ ${terminal_state} == cutover-complete ]]; then
  print -- ${cutover_evidence}
  exit 0
fi
[[ ${terminal_state} == absent ]] || {
  print -u2 -- 'This release context is terminal and cannot be applied.'
  exit 1
}
[[ ! -e ${rollback_evidence} && ! -e ${serve_rollback_after} && \
    ! -e ${serve_before} && ! -e ${serve_after} && ! -e ${cutover_evidence} && \
    ! -e ${transaction} ]] || {
  print -u2 -- 'Absent terminal state conflicts with existing release evidence.'
  exit 1
}
assert_current_pointer
typeset self_dns
self_dns=$(bounded_command 5 tailscale status --self --json | \
  jq -er '.Self.DNSName | rtrimstr(".")')
[[ ${self_dns} == ${expected_host} ]] || {
  print -u2 -- "Unexpected Tailscale identity: ${self_dns}"
  exit 1
}

if [[ ${mode} == upgrade ]]; then
  [[ -f ${config} && -f ${plist} ]] || {
    print -u2 -- 'Upgrade requires an existing config and plist.'
    exit 1
  }
  assert_owner_private_file ${config}
  assert_owner_private_file ${plist}
  assert_upgrade_runtime 12.0
else
  assert_first_install_absent
fi

write_terminal_marker in-progress cutover-apply
terminal_state=in-progress
terminal_operation=cutover-apply
capture_serve_snapshot ${serve_before}
bounded_command 5 ${staged_node} ${release}/scripts/release-serve-config.mjs \
  --before ${serve_before} --after ${serve_before} --mode ${mode} --baseline >/dev/null
if [[ ${mode} == upgrade ]]; then
  copy_private_atomically ${config} ${config_before}
  copy_private_atomically ${plist} ${plist_before}
  compare_private_files ${config_before} ${config}
  compare_private_files ${plist_before} ${plist}
  assert_upgrade_runtime 12.0
fi

jq -n --arg dataDir "${HOME}/.journal" '{
  port: 5178,
  bindHost: "127.0.0.1",
  dataDir: $dataDir,
  hostAllowlist: [
    "localhost:5178",
    "127.0.0.1:5178",
    "mickey-home.tail8a9beb.ts.net:5178"
  ],
  tailnetHostname: "mickey-home.tail8a9beb.ts.net:5178",
  timezone: "Europe/Amsterdam",
  dayBoundaryOffsetMin: 0
}' | write_json_atomically ${config_next}

transaction_command transaction-create
cutover_transaction_active=1
transaction_command transaction-validate
verify_deployed_tree
assert_current_pointer

restore_private_atomically ${config_next} ${config}
NODE_ENV=production JOURNAL_VERSION=${version} JOURNAL_CONFIG=${config} \
  bounded_command 15 ${staged_node} ${staged_cli} install-service >/dev/null
typeset runtime_json
runtime_json=$(bounded_command 35 \
  ${staged_node} ${release}/scripts/release-verify-runtime.mjs \
  --release ${release} --manifest ${manifest} --node ${staged_node} \
  --timeout-ms 30000)

if [[ ${mode} == first-install ]]; then
  bounded_command 10 tailscale serve --bg --yes --https=5178 http://127.0.0.1:5178
fi
capture_serve_snapshot ${serve_after}
typeset serve_json tailnet_json
serve_json=$(bounded_command 5 \
  ${staged_node} ${release}/scripts/release-serve-config.mjs \
  --before ${serve_before} --after ${serve_after} --mode ${mode})
tailnet_json=$(bounded_command 20 \
  ${staged_node} ${release}/scripts/release-verify-runtime.mjs \
  --origin-only \
  --origin https://mickey-home.tail8a9beb.ts.net:5178 \
  --manifest ${manifest} \
  --timeout-ms 15000)
verify_deployed_tree
assert_current_pointer

jq -n \
  --arg stamp "${stamp}" \
  --arg mode "${mode}" \
  --arg baseCommit "${base_commit}" \
  --arg manifestSha256 "${manifest_sha256}" \
  --arg archiveSha256 "${archive_sha256}" \
  --argjson runtime "${runtime_json}" \
  --argjson tailscale "${serve_json}" \
  --argjson tailnet "${tailnet_json}" \
  '{
    schemaVersion: 1,
    releaseStamp: $stamp,
    mode: $mode,
    recordedAt: (now | todateiso8601),
    baseCommit: $baseCommit,
    manifestSha256: $manifestSha256,
    archiveSha256: $archiveSha256,
    currentReleaseUnchanged: true,
    runtime: $runtime,
    tailscale: $tailscale,
    tailnet: $tailnet
  }' | write_json_atomically ${cutover_evidence}
cutover_committed=1
assert_current_pointer
cleanup_committed_transaction
cutover_transaction_active=0
write_terminal_marker cutover-complete cutover-apply
print -- ${cutover_evidence}
