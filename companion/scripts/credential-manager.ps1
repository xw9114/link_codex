param(
  [Parameter(Mandatory=$true)][ValidateSet('set','get','delete')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Target
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexLinkCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32", EntryPoint="CredFree", SetLastError=true)]
  private static extern void CredFree(IntPtr buffer);

  public static void Write(string target, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL credential = new CREDENTIAL {
        Type = 1, TargetName = target, UserName = "CodexLink",
        CredentialBlobSize = (UInt32)bytes.Length, CredentialBlob = blob, Persist = 2
      };
      if (!CredWrite(ref credential, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.ZeroFreeGlobalAllocUnicode(blob); }
  }

  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new System.ComponentModel.Win32Exception(error);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return "";
      return Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);
    } finally { CredFree(pointer); }
  }

  public static void Delete(string target) {
    if (!CredDelete(target, 1, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error != 1168) throw new System.ComponentModel.Win32Exception(error);
    }
  }
}
'@

switch ($Action) {
  'set' {
    $secret = [Console]::In.ReadToEnd()
    [CodexLinkCredentialManager]::Write($Target, $secret)
  }
  'get' {
    $secret = [CodexLinkCredentialManager]::Read($Target)
    if ($null -ne $secret) { [Console]::Out.Write($secret) }
  }
  'delete' { [CodexLinkCredentialManager]::Delete($Target) }
}
