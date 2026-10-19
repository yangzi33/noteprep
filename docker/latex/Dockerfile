# Compilation sandbox image (CLAUDE.md section 8). It contains TeX and a fixed entry script, and nothing else the job
# should not read: no credentials, no application code, no network at runtime (the worker starts it with --network none).
# Packages are installed at BUILD time only; nothing is installed or downloaded when a document is compiled.
#
# Base pinned by digest (debian:bookworm-slim, linux/amd64). Debian removes old package versions, so the exact
# versions that were installed are recorded in packages.lock and checked by `pnpm test:latex`: a rebuild that
# changes them fails the test until the lock is updated on purpose.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-latex-base \
      texlive-latex-recommended \
      texlive-fonts-recommended \
      lmodern \
      poppler-utils \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/* /usr/share/doc /usr/share/man

# Shell escape off at the configuration level too (Debian builds texmf.cnf from /etc/texmf/texmf.d with update-texmf).
# This is defense in depth: the compile script also passes -no-shell-escape, and the real boundary is the container.
COPY texmf.cnf /etc/texmf/texmf.d/99-noteprep.cnf
RUN update-texmf
COPY compile.sh /usr/local/bin/compile.sh
RUN chmod 0555 /usr/local/bin/compile.sh \
 && mkdir /work \
 && chown 65534:65534 /work

USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/compile.sh"]
