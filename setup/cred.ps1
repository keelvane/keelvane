# Windows Credential Manager access for the connector token. Only targets that start with "Keelvane" are
# accepted, so this script can never read or change anyone else's entries. The secret arrives on stdin.
param([Parameter(Mandatory)][ValidateSet('set','get','has','del')][string]$Action, [Parameter(Mandatory)][string]$Target)
$ErrorActionPreference = 'Stop'
if ($Target -notlike 'Keelvane*') { throw 'target must start with Keelvane' }
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class KvCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL c, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret); IntPtr p = Marshal.AllocHGlobal(b.Length); Marshal.Copy(b, 0, p, b.Length);
    try { CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.CredentialBlobSize = (uint)b.Length; c.CredentialBlob = p; c.Persist = 2; c.UserName = "keelvane";
      if (!CredWrite(ref c, 0)) throw new Exception("CredWrite failed " + Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(p); }
  }
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, (int)c.CredentialBlobSize / 2); } finally { CredFree(p); }
  }
  public static bool Delete(string target) { return CredDelete(target, 1, 0); }
}
"@
switch ($Action) {
  'set' { [KvCred]::Write($Target, [Console]::In.ReadToEnd().Trim()) }
  'get' { $v = [KvCred]::Read($Target); if ($null -eq $v) { exit 3 }; [Console]::Out.Write($v) }
  'has' { if ($null -eq [KvCred]::Read($Target)) { exit 3 } }
  'del' { [void][KvCred]::Delete($Target) }
}
