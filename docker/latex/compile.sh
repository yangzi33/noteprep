#!/bin/sh
# Reads a tar of <name>.tex files on stdin, compiles each, writes a tar of results on stdout.
# Output per document: <name>.pdf (only if it compiled), <name>.log (truncated), <name>.json ({"pages":N}).
# Exit status: 0 all compiled; 10 at least one failed to compile (the tar still carries the logs); 70+ setup errors.
set -u
umask 077
cd /work || exit 70
mkdir in out || exit 70

# The input is tarred by the trusted worker; it is still unpacked without trusting ownership or permissions.
tar -xf - -C in --no-same-owner --no-same-permissions 2>/dev/null || exit 71

status=0
for path in in/*.tex; do
  [ -e "$path" ] || exit 72
  name=${path#in/}
  name=${name%.tex}
  case "$name" in
    *[!a-z0-9]*|"") exit 73 ;;   # fixed, boring names only
  esac
  # -no-shell-escape and the other flags are fixed here; the document cannot change them.
  if timeout -k 2 "${TEX_TIMEOUT:-60}" pdflatex -no-shell-escape -halt-on-error -interaction=nonstopmode \
       -file-line-error -output-directory out "$path" >"out/$name.run" 2>&1; then
    pages=$(pdfinfo "out/$name.pdf" 2>/dev/null | sed -n 's/^Pages: *\([0-9][0-9]*\)$/\1/p')
    case "$pages" in
      ""|*[!0-9]*) rm -f "out/$name.pdf"; status=10 ;;
      *) printf '{"pages":%s}\n' "$pages" >"out/$name.json" ;;
    esac
  else
    rm -f "out/$name.pdf"
    status=10
  fi
  # A bounded log for diagnosis; the worker redacts it before it can reach anyone.
  head -c 20000 "out/$name.log" >"out/$name.log.tmp" 2>/dev/null && mv "out/$name.log.tmp" "out/$name.log" || true
  rm -f "out/$name.run" "out/$name.aux"
done

tar -cf - -C out . || exit 74
exit $status
