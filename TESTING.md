# VM Reconfiguration Runbook

Steps to reconfigure a lobsterd VM from scratch. Intended to be run sequentially by an agent.
Assumes `doctl` is already installed and authenticated.

---

## Steps

### 1. Delete and recreate the DigitalOcean droplet

```bash
# List droplets — expect exactly one
doctl compute droplet list --format ID,Name,Region,SizeSlug,Image,Status,PublicIPv4

# Delete it (substitute the ID from the list)
doctl compute droplet delete <DROPLET_ID> --force

# Recreate: Ubuntu 24.04 LTS, s-1vcpu-2gb ($12/mo, 2GB), tor1 region, all SSH keys
doctl compute droplet create ubuntu-s-1vcpu-2gb-tor1-01 \
  --region tor1 \
  --size s-1vcpu-2gb \
  --image ubuntu-24-04-x64 \
  --ssh-keys "$(doctl compute ssh-key list --format ID --no-header | tr '\n' ',')" \
  --wait \
  --format ID,Name,PublicIPv4,Status
```

The new droplet will have a **different IP** — note it for subsequent steps.

### 2. Update Cloudflare DNS to point to the new droplet

The setup is: `gradeprompt.com` has an A record, and `*.gradeprompt.com` CNAMEs to it. So we only need to update the root A record.

Requires a Cloudflare API token with `Zone:DNS:Edit` for `gradeprompt.com`.

```bash
CF_TOKEN="gmpfAilJMyqxL_Ps9-SuGzG2hv-8xT4YL4ftYFwY"
ZONE_ID="16f9b71ae032a29139be284dbd7c946d"  # gradeprompt.com
NEW_IP="<NEW_DROPLET_IP>"

# Find the root A record ID
ROOT_RECORD_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=gradeprompt.com&type=A" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")

# Update the A record to the new IP
curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${ROOT_RECORD_ID}" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"type\":\"A\",\"name\":\"gradeprompt.com\",\"content\":\"${NEW_IP}\",\"ttl\":1,\"proxied\":true}" | python3 -m json.tool
```

The wildcard `*.gradeprompt.com` is a CNAME to `gradeprompt.com`, so it follows automatically.

### 3. Install prerequisites on the droplet

```bash
HOST="<NEW_DROPLET_IP>"
ssh -o StrictHostKeyChecking=no root@${HOST} "apt-get update && apt-get install -y unzip && curl -fsSL https://bun.sh/install | bash"
```

### 4. Clone the lobsterd repo

```bash
ssh root@${HOST} "git clone https://github.com/GratefulWorkspace/lobsterd.git /root/lobsterd"
```

### 5. Install dependencies and run lobsterd init

```bash
ssh root@${HOST} "export PATH=/root/.bun/bin:\$PATH && cd /root/lobsterd && bun install"
```

Then run lobsterd init:

```bash
ssh root@${HOST} "export PATH=/root/.bun/bin:\$PATH && cd /root/lobsterd && bun run ./src/index.tsx init -d gradeprompt.com -y"
```

### 6. Spawn the tenant

```bash
ssh root@${HOST} "export PATH=/root/.bun/bin:\$PATH && cd /root/lobsterd && bun run ./src/index.tsx spawn tenant1"
```
