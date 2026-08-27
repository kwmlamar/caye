FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-gmsh \
      gmsh \
      calculix-ccx \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Fail the image build if either half of the deterministic FEA toolchain is missing.
RUN python3 -c "import gmsh; print(gmsh.__version__)" \
 && ccx -v

WORKDIR /vercel/sandbox
