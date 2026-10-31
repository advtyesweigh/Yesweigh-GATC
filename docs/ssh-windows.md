# SSH: Mac ↔ Windows VPS

## Mac: generate key (if missing)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gatc_vps -C "gatc-vps-mac"
# Enter a strong passphrase when prompted
```

Keep `~/.ssh/gatc_vps` private. Never commit or transmit it.

Display the public key to install on Windows:

```bash
cat ~/.ssh/gatc_vps.pub
```

## Mac: SSH config host entry

Add to `~/.ssh/config`:

```sshconfig
Host GATC-VPS
  HostName 103.138.96.43
  User gatcdev
  Port 22
  IdentityFile ~/.ssh/gatc_vps
  IdentitiesOnly yes
  PreferredAuthentications publickey
  PasswordAuthentication no
```

## Windows: create `gatcdev` (RDP as Administrator, once)

In an elevated PowerShell on the VPS:

```powershell
$Password = Read-Host -AsSecureString "Password for gatcdev"
New-LocalUser -Name "gatcdev" -Password $Password -FullName "GATC Developer" -Description "GATC least-privilege SSH account"
Add-LocalGroupMember -Group "Users" -Member "gatcdev"
# Optional: allow Remote Desktop if needed
# Add-LocalGroupMember -Group "Remote Desktop Users" -Member "gatcdev"
```

Do not use Administrator for routine development.

## Windows: install public key

Still on the VPS (adjust if OpenSSH uses a different profile path):

```powershell
$User = "gatcdev"
$PubKey = "PASTE_PUBLIC_KEY_LINE_HERE"
$SshDir = "C:\Users\$User\.ssh"
New-Item -ItemType Directory -Force -Path $SshDir | Out-Null
$AuthKeys = Join-Path $SshDir "authorized_keys"
Set-Content -Path $AuthKeys -Value $PubKey -Encoding ascii

# Permissions: authorized_keys and .ssh must not be overly permissive
icacls $SshDir /inheritance:r
icacls $SshDir /grant:r "$User:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F" /grant:r "Administrators:(OI)(CI)F"
icacls $AuthKeys /inheritance:r
icacls $AuthKeys /grant:r "$User:F" /grant:r "SYSTEM:F" /grant:r "Administrators:F"
```

Confirm OpenSSH is running:

```powershell
Get-Service sshd
```

## Verify host fingerprint before first trust

1. Connect via RDP with credentials you already trust.
2. On the VPS, print the host key fingerprint, e.g.:

```powershell
Get-ChildItem C:\ProgramData\ssh\ssh_host_*_key.pub | ForEach-Object {
  ssh-keygen -lf $_.FullName
}
```

3. From the Mac, on first connect compare the presented fingerprint to the RDP-verified value before typing `yes`.

## Connectivity checks (Mac)

```bash
nc -vz 103.138.96.43 22
ssh -o BatchMode=yes -o PreferredAuthentications=publickey GATC-VPS "whoami"
```

If authentication fails, stop and diagnose — do not hammer password prompts.

## Network hardening (recommended)

Restrict inbound TCP/22 at the VPS firewall or provider security group to trusted office/VPN IPs. Do not change firewall rules without explicit approval.
