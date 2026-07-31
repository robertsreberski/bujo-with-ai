#!/bin/zsh

emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL NO_CLOBBER
zmodload zsh/datetime
zmodload zsh/system
zmodload -F zsh/stat b:zstat
umask 077

typeset -r script_dir=${0:A:h}
typeset -r repository=${script_dir:h}
typeset -r context=${1:?Usage: release-lifecycle.zsh <release-context.json>}
[[ ${PWD:A} == ${repository:A} ]] || {
  print -u2 -- "Run this helper from the canonical checkout: ${repository}"
  exit 1
}
[[ ${OSTYPE} == darwin* ]] || {
  print -u2 -- 'Release lifecycle verification requires macOS.'
  exit 1
}
for command_name in curl jq shasum; do
  command -v ${command_name} >/dev/null || {
    print -u2 -- "Required command is missing: ${command_name}"
    exit 1
  }
done
[[ -x /usr/bin/perl ]] || {
  print -u2 -- 'Required command is missing: /usr/bin/perl'
  exit 1
}

typeset -r label=com.rsreberski.journald
typeset user_id stamp release manifest expected_node expected_version
typeset base_commit manifest_sha256 archive_sha256
user_id=$(id -u)
stamp=$(jq -er '.releaseStamp' ${context})
release=$(jq -er '.releaseRoot' ${context})
manifest=$(jq -er '.manifest' ${context})
expected_node=$(jq -er '.toolchain.nodePath' ${manifest})
expected_version=$(jq -er '.release.version' ${manifest})
base_commit=$(jq -er '.baseCommit' ${context})
manifest_sha256=$(jq -er '.manifestSha256' ${context})
archive_sha256=$(jq -er '.archiveSha256' ${context})
typeset -r user_id stamp release manifest expected_node expected_version
typeset -r base_commit manifest_sha256 archive_sha256
typeset -r service_target=gui/${user_id}/${label}
typeset -r evidence=${context:A:h}/lifecycle-${stamp}.json
typeset -r deployed_attestation=${context:A:h}/deployed-tree-${stamp}.json
typeset -r terminal_marker=${context:A:h}/terminal-${stamp}.lock
typeset -r terminal_helper=${release}/scripts/release-cutover-transaction.mjs
typeset -r global_lock=${HOME}/.journal/release-global.lock
typeset -r stamp_pattern='^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$'
[[ ${stamp} =~ ${stamp_pattern} ]] || {
  print -u2 -- "Invalid release stamp: ${stamp}"
  exit 1
}
typeset actual_manifest_sha expected_lifecycle_sha actual_lifecycle_sha
typeset actual_node_version expected_node_version actual_node_path
actual_manifest_sha=$(shasum -a 256 ${manifest} | awk '{print $1}')
[[ ${actual_manifest_sha} == ${manifest_sha256} ]] || {
  print -u2 -- 'Manifest hash no longer matches the release context.'
  exit 1
}
expected_lifecycle_sha=$(jq -er \
  '.files[] | select(.path == "scripts/release-lifecycle.zsh" and .kind == "file") | .sha256' \
  ${manifest})
actual_lifecycle_sha=$(shasum -a 256 ${0:A} | awk '{print $1}')
[[ ${actual_lifecycle_sha} == ${expected_lifecycle_sha} ]] || {
  print -u2 -- 'release-lifecycle.zsh changed after release attestation.'
  exit 1
}
[[ -d ${release} && ! -L ${release} && ${release:A} == ${HOME}/.journal/releases/${stamp} ]] || {
  print -u2 -- 'Lifecycle release ownership or identity is invalid.'
  exit 1
}
actual_node_version=$(${expected_node} --version)
expected_node_version=$(jq -er '.toolchain.node' ${manifest})
actual_node_path=$(${expected_node} -p 'process.execPath')
[[ ${actual_node_version} == ${expected_node_version} && ${actual_node_path} == ${expected_node} ]] || {
  print -u2 -- 'Attested Node runtime is unavailable or has changed.'
  exit 1
}
[[ -f ${terminal_helper} && ! -L ${terminal_helper} ]] || {
  print -u2 -- 'The staged terminal-state helper is unavailable.'
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

typeset global_lock_fd=-1

function assert_global_lock_identity {
  typeset -r journal_require_mode=${1:-yes}
  typeset -A journal_lock_descriptor_stat journal_lock_path_stat
  (( global_lock_fd >= 0 )) || return 1
  zstat -f ${global_lock_fd} -H journal_lock_descriptor_stat || return 1
  zstat -L -H journal_lock_path_stat ${global_lock} || return 1
  [[ ${journal_lock_descriptor_stat[device]} == ${journal_lock_path_stat[device]} && \
      ${journal_lock_descriptor_stat[inode]} == ${journal_lock_path_stat[inode]} && \
      ${journal_lock_descriptor_stat[uid]} == ${user_id} && \
      ${journal_lock_path_stat[uid]} == ${user_id} && \
      ${journal_lock_descriptor_stat[nlink]} == 1 && \
      ${journal_lock_path_stat[nlink]} == 1 && \
      $(( journal_lock_descriptor_stat[mode] & 8#170000 )) == $(( 8#100000 )) && \
      $(( journal_lock_path_stat[mode] & 8#170000 )) == $(( 8#100000 )) ]] || {
    print -u2 -- 'The stable global release lock has unsafe ownership or identity.'
    return 1
  }
  if [[ ${journal_require_mode} == yes ]]; then
    [[ $(( journal_lock_descriptor_stat[mode] & 8#7777 )) == $(( 8#600 )) && \
        $(( journal_lock_path_stat[mode] & 8#7777 )) == $(( 8#600 )) ]] || {
      print -u2 -- 'The stable global release lock is not mode 0600.'
      return 1
    }
  fi
}

function acquire_global_lock {
  sysopen -rw -o creat,nofollow -m 0600 -u global_lock_fd ${global_lock} || {
    print -u2 -- 'The stable global release lock could not be opened safely.'
    return 1
  }
  if ! assert_global_lock_identity no; then
    exec {global_lock_fd}>&-
    global_lock_fd=-1
    return 1
  fi
  /bin/chmod 600 /dev/fd/${global_lock_fd}
  if ! assert_global_lock_identity yes; then
    exec {global_lock_fd}>&-
    global_lock_fd=-1
    return 1
  fi
  if ! /usr/bin/lockf -s -t 0 ${global_lock_fd}; then
    print -u2 -- 'Another global release operation holds the global release lock.'
    exec {global_lock_fd}>&-
    global_lock_fd=-1
    return 75
  fi
  if ! assert_global_lock_identity yes; then
    exec {global_lock_fd}>&-
    global_lock_fd=-1
    return 1
  fi
}

function release_global_lock {
  typeset journal_release_failed=0
  if (( global_lock_fd >= 0 )); then
    assert_global_lock_identity yes || journal_release_failed=1
    exec {global_lock_fd}>&- || journal_release_failed=1
    global_lock_fd=-1
  fi
  return ${journal_release_failed}
}

function lifecycle_exit_handler {
  typeset journal_lifecycle_exit=$?
  trap - EXIT HUP INT TERM
  unsetopt ERR_EXIT
  release_global_lock || journal_lifecycle_exit=1
  exit ${journal_lifecycle_exit}
}

function assert_cutover_terminal {
  typeset journal_terminal_json
  [[ ! -e ${terminal_marker}.next && ! -L ${terminal_marker}.next ]] || {
    print -u2 -- 'The lifecycle terminal marker has unresolved prepared residue.'
    return 1
  }
  journal_terminal_json=$(bounded_command 10 \
    ${expected_node} ${terminal_helper} terminal-read \
    --path ${terminal_marker} --release-stamp ${stamp}) || return 1
  print -r -- ${journal_terminal_json} | jq -e --arg stamp "${stamp}" '
    keys == ["operation", "pid", "recordedAt", "releaseStamp", "schemaVersion", "state"] and
    .schemaVersion == 2 and .releaseStamp == $stamp and
    .state == "cutover-complete" and .operation == "cutover-apply"
  ' >/dev/null || {
    print -u2 -- 'Lifecycle requires exact cutover-complete terminal ownership.'
    return 1
  }
}

function live_pid {
  typeset -r journal_launchctl_timeout=${1:-2}
  bounded_command ${journal_launchctl_timeout} /bin/launchctl print ${service_target} | awk '
    /^[[:space:]]*pid = [0-9]+[[:space:]]*$/ { count += 1; pid = $3 }
    END { if (count != 1 || pid < 1) exit 1; print pid }
  '
}

function wait_dead {
  typeset -r target_pid=$1
  typeset -r target_signal=$2
  typeset -r started=${EPOCHREALTIME}
  while kill -0 ${target_pid} 2>/dev/null; do
    (( EPOCHREALTIME - started <= 5.0 )) || {
      print -u2 -- "${target_signal} PID ${target_pid} did not exit within five seconds."
      return 1
    }
    sleep 0.05
  done
  printf '%.3f\n' "$(( (EPOCHREALTIME - started) * 1000.0 ))"
}

function wait_recovered {
  typeset -r excluded_one=$1
  typeset -r excluded_two=${2:-0}
  typeset -r deadline=$(( EPOCHREALTIME + 15.0 ))
  typeset candidate health remaining launch_timeout health_timeout recovery_sleep
  while (( EPOCHREALTIME <= deadline )); do
    remaining=$(( deadline - EPOCHREALTIME ))
    (( remaining > 0.0 )) || break
    launch_timeout=$(( remaining < 1.0 ? remaining : 1.0 ))
    if candidate=$(live_pid ${launch_timeout} 2>/dev/null); then
      if [[ ${candidate} != ${excluded_one} && ${candidate} != ${excluded_two} ]]; then
        remaining=$(( deadline - EPOCHREALTIME ))
        (( remaining > 0.0 )) || break
        health_timeout=$(( remaining < 0.25 ? remaining : 0.25 ))
        if health=$(bounded_command ${remaining} curl \
          --fail --silent --show-error --max-time ${health_timeout} \
          http://127.0.0.1:5178/healthz 2>/dev/null); then
          remaining=$(( deadline - EPOCHREALTIME ))
          (( remaining > 0.0 )) || break
          if print -r -- ${health} | bounded_command ${remaining} \
            jq -e --arg version "${expected_version}" \
            '.status == "ok" and .db == "ok" and .version == $version' >/dev/null; then
            print -- ${candidate}
            return 0
          fi
        fi
      fi
    fi
    remaining=$(( deadline - EPOCHREALTIME ))
    (( remaining > 0.0 )) || break
    recovery_sleep=$(( remaining < 0.1 ? remaining : 0.1 ))
    sleep ${recovery_sleep}
  done
  print -u2 -- 'launchd did not recover a distinct healthy PID within 15 seconds.'
  return 1
}

typeset deployed_initial deployed_final initial_runtime term_pid current_term_pid term_elapsed_ms term_recovered_pid
typeset term_runtime verified_term_pid current_kill_pid kill_elapsed_ms kill_recovered_pid
typeset kill_runtime verified_kill_pid
acquire_global_lock
trap lifecycle_exit_handler EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[[ ! -e ${evidence} && ! -L ${evidence} ]] || {
  print -u2 -- "Lifecycle evidence already exists: ${evidence}"
  exit 1
}
deployed_initial=$(bounded_command 30 \
  ${expected_node} ${release}/scripts/release-deployed-tree.mjs --verify \
  --context ${context} --root ${release} --attestation ${deployed_attestation})
assert_cutover_terminal
initial_runtime=$(bounded_command 20 \
  ${expected_node} ${release}/scripts/release-verify-runtime.mjs \
  --release ${release} --manifest ${manifest} --node ${expected_node})
term_pid=$(print -r -- ${initial_runtime} | jq -er '.pid')
current_term_pid=$(live_pid 2)
[[ ${term_pid} == ${current_term_pid} ]] || {
  print -u2 -- 'SIGTERM target no longer matches launchd PID.'
  exit 1
}
kill -TERM ${term_pid}
term_elapsed_ms=$(wait_dead ${term_pid} SIGTERM)
(( term_elapsed_ms <= 5000.0 )) || {
  print -u2 -- "SIGTERM exceeded five seconds: ${term_elapsed_ms}ms"
  exit 1
}
term_recovered_pid=$(wait_recovered ${term_pid})
term_runtime=$(bounded_command 20 \
  ${expected_node} ${release}/scripts/release-verify-runtime.mjs \
  --release ${release} --manifest ${manifest} --node ${expected_node})
verified_term_pid=$(print -r -- ${term_runtime} | jq -er '.pid')
[[ ${verified_term_pid} == ${term_recovered_pid} ]] || {
  print -u2 -- 'Post-SIGTERM runtime changed PID during verification.'
  exit 1
}

current_kill_pid=$(live_pid 2)
[[ ${term_recovered_pid} == ${current_kill_pid} ]] || {
  print -u2 -- 'SIGKILL target no longer matches launchd PID.'
  exit 1
}
kill -KILL ${term_recovered_pid}
kill_elapsed_ms=$(wait_dead ${term_recovered_pid} SIGKILL)
kill_recovered_pid=$(wait_recovered ${term_recovered_pid} ${term_pid})
kill_runtime=$(bounded_command 20 \
  ${expected_node} ${release}/scripts/release-verify-runtime.mjs \
  --release ${release} --manifest ${manifest} --node ${expected_node})
verified_kill_pid=$(print -r -- ${kill_runtime} | jq -er '.pid')
[[ ${verified_kill_pid} == ${kill_recovered_pid} ]] || {
  print -u2 -- 'Post-SIGKILL runtime changed PID during verification.'
  exit 1
}
deployed_final=$(bounded_command 30 \
  ${expected_node} ${release}/scripts/release-deployed-tree.mjs --verify \
  --context ${context} --root ${release} --attestation ${deployed_attestation})
[[ $(print -r -- ${deployed_initial} | jq -cS .) == \
   $(print -r -- ${deployed_final} | jq -cS .) ]] || {
  print -u2 -- 'Deployed release tree changed during lifecycle verification.'
  exit 1
}

jq -n \
  --arg stamp "${stamp}" \
  --arg baseCommit "${base_commit}" \
  --arg manifestSha256 "${manifest_sha256}" \
  --arg archiveSha256 "${archive_sha256}" \
  --argjson deployedTree "${deployed_final}" \
  --argjson initial "${initial_runtime}" \
  --arg termPid "${term_pid}" \
  --arg termElapsedMs "${term_elapsed_ms}" \
  --arg termRecoveredPid "${term_recovered_pid}" \
  --argjson termRuntime "${term_runtime}" \
  --arg killPid "${term_recovered_pid}" \
  --arg killElapsedMs "${kill_elapsed_ms}" \
  --arg killRecoveredPid "${kill_recovered_pid}" \
  --argjson killRuntime "${kill_runtime}" \
  '{
    schemaVersion: 1,
    releaseStamp: $stamp,
    recordedAt: (now | todateiso8601),
    baseCommit: $baseCommit,
    manifestSha256: $manifestSha256,
    archiveSha256: $archiveSha256,
    deployedTree: ($deployedTree + {stableDuringLifecycle: true}),
    initialRuntime: $initial,
    sigterm: {
      signal: "SIGTERM",
      exactPid: ($termPid | tonumber),
      exitElapsedMs: ($termElapsedMs | tonumber),
      withinFiveSeconds: (($termElapsedMs | tonumber) <= 5000),
      recoveredPid: ($termRecoveredPid | tonumber),
      distinctRecovery: ($termRecoveredPid != $termPid),
      runtime: $termRuntime
    },
    sigkill: {
      signal: "SIGKILL",
      exactPid: ($killPid | tonumber),
      exitElapsedMs: ($killElapsedMs | tonumber),
      recoveredPid: ($killRecoveredPid | tonumber),
      distinctRecovery: ($killRecoveredPid != $killPid),
      runtime: $killRuntime
    }
  }' | ${expected_node} ${release}/scripts/release-atomic-file.mjs \
    --json --output ${evidence} >/dev/null
print -- ${evidence}
