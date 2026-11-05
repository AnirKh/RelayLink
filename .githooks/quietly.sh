# Sourced by pre-commit and pre-push (not a hook itself: git runs only files
# named after a hook).
#
# quietly SCRIPT HOOK — runs `npm run SCRIPT` and shows only what a person
# reads: the count when everything passed, the failures when something did
# not. Every commit and push used to print the name of each of some 1,300
# tests, and the result was at the bottom of it.
#
# The test scripts name the spec reporter, so the output is the same on every
# Node version: Node 22 writes TAP instead when nobody is watching the screen.

quietly() {
  log=$(mktemp)
  if npm run --silent "$1" >"$log" 2>&1; then
    pass=$(sed -n 's/^ℹ pass //p' "$log")
    echo "$2: ${pass:-all} tests passed"
    rm -f "$log"
    return 0
  fi
  if grep -q '^✖ failing tests:' "$log"; then
    sed -n '/^✖ failing tests:/,$p' "$log"
  else
    tail -n 60 "$log"
  fi
  echo "$2: the whole output is in $log"
  return 1
}
