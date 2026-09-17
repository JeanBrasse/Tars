#!/bin/bash
# Design guardrail: fails when banned styling creeps back in.
#
# Every rule reads the .ts, .tsx and .css files under src/: class names live in
# constants as well as in markup, and an @apply can carry a shadow or a raw
# colour into a stylesheet.
#
# grep answers in three ways, and only one of them is a pass: 0 found a line, 1
# found none, 2 could not search (a file or folder it cannot read, a pattern it
# cannot parse). Until 17/09 this script threw grep's errors away and read "no
# line left" as a pass: a src/ that did not exist, a pattern grep refused and a
# violation in a file grep could not open all printed five green ticks. It read
# .tsx files only, and 13 lines of raw palette sat in .ts files unseen.
set -u
fail=0
sources=(--include='*.ts' --include='*.tsx' --include='*.css')

# The paths whose job is to define raw appearance, left out of every rule, each
# with its reason. Matched against the start of the path grep prints, so a line
# that merely mentions one of them is still read.
exempt='^src/components/ui/'        # the shared primitives: the one place raw appearance is defined
exempt+='|^src/app/icon\.tsx:'      # drawn by next/og into an image, where no stylesheet or token reaches

# What every rule reads. A rule that reads nothing finds nothing, and finding
# nothing is a pass. Measured on macOS: once --include is given, grep answers a
# src/ that does not exist with 1 and no message, exactly as it answers a clean
# tree. So the files are counted, and none is a failure.
listing=$(grep -rcaE "${sources[@]}" -e '' src)
status=$?
if [ "$status" -gt 1 ]; then
  echo "✗ could not read everything under src/ (grep exited $status)"
  exit 1
fi
files=$(printf '%s' "$listing" | grep -c '')
if [ "$files" -eq 0 ]; then
  echo "✗ no .ts, .tsx or .css file under src/: nothing was checked"
  exit 1
fi
echo "$files files read under src/"

check() {
  local label="$1" pattern="$2"
  local hits status
  hits=$(grep -rnaE "${sources[@]}" -e "$pattern" src)
  status=$?
  # Lines found, minus the exempt paths: the filter answers in the same three ways.
  if [ "$status" -eq 0 ]; then
    hits=$(printf '%s\n' "$hits" | grep -avE "$exempt")
    status=$?
  fi
  case "$status" in
    0)
      echo "✗ $label"
      echo "$hits" | head -8 | sed 's/^/    /'
      local n; n=$(echo "$hits" | wc -l | tr -d ' ')
      [ "$n" -gt 8 ] && echo "    … $((n - 8)) more"
      fail=1
      ;;
    1)
      echo "✓ $label"
      ;;
    *)
      echo "✗ $label: grep could not search (exit $status)"
      fail=1
      ;;
  esac
}

check "no inline border-radius"        "style=\{\{ *borderRadius"
check "no drop shadows"                "shadow-(sm|md|lg|xl|2xl)"
check "no gradients"                   "bg-gradient"
check "no decorative ping"             "animate-ping"
check "no raw tailwind palette"        "(text|bg|border)-(red|green|blue|amber|purple|cyan|yellow|orange|zinc|slate|gray)-[0-9]"

exit $fail
