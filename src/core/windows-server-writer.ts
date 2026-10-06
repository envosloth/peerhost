import { execFile } from 'node:child_process';
import path from 'node:path';
import { lstat } from 'node:fs/promises';

// Fixed trusted code only; filenames/content are JSON stdin, never PowerShell source.
// All ancestors are held without FILE_SHARE_DELETE; the target also denies
// sharing writes/deletes. Publication uses two handle-renames with no overwrite:
// the original becomes its backup, then the flushed stage takes the vacant name.
// A flushed journal precedes either rename. Recovery leases the same ancestors,
// verifies original/stage identities and hashes, and never overwrites a rival.
// CreateFile is authoritative: File.Exists hides access errors/follows links.
// Rollback restores only the original handle into a vacant target name.
// Keep commentary outside the encoded script to fit Windows command limits.
const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class Writer {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attr,CL,CH,AL,AH,WL,WH,Volume,SizeH,SizeL,Links,IndexH,IndexL;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string p,uint a,uint s,IntPtr sec,uint d,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr h,StringBuilder b,uint n,uint f);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr h,byte[] b,uint n,out uint r,IntPtr o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr h,byte[] b,uint n,out uint r,IntPtr o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr h,int c,IntPtr b,uint n);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 static void Fail(string op) {throw new IOException("Safe save refused: "+op+" (Win32 "+Marshal.GetLastWin32Error()+")");}
 static IntPtr Open(string p,uint a,uint s,uint d,uint f) {
  var h=CreateFileW(p,a,s,IntPtr.Zero,d,f,IntPtr.Zero); if(h.ToInt64()==-1) Fail("open");return h;
 }
 static Info Check(IntPtr h,string p,bool dir) {
  Info i;if(!GetFileInformationByHandle(h,out i))Fail("identity");
  if((i.Attr&0x400)!=0 || ((i.Attr&0x10)!=0)!=dir)throw new IOException("Links/junctions or nonordinary paths refused");
  var b=new StringBuilder(8192);uint n=GetFinalPathNameByHandleW(h,b,8192,0);
  if(n==0 || n>=8192)Fail("final path");
  if(!String.Equals(b.ToString().Substring(4).TrimEnd('\\'),p.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("Directory/file identity changed; refresh");
  if(!dir && i.Links!=1)throw new IOException("Hard-linked server files refused");return i;
 }
 static byte[] Read(IntPtr h) {
  Info i;if(!GetFileInformationByHandle(h,out i))Fail("size");if(i.SizeH!=0 || i.SizeL>262144)throw new IOException("File too large");
  byte[] b=new byte[i.SizeL];uint n;if(!ReadFile(h,b,(uint)b.Length,out n,IntPtr.Zero)||n!=b.Length)Fail("read");return b;
 }
 public static string Hash(byte[] b) {using(var s=SHA256.Create())return BitConverter.ToString(s.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
 static IntPtr Create(string p,byte[] b) {
  var h=Open(p,0xC0010000,1,1,0x00200000);try {
   Check(h,p,false);uint n;if(!WriteFile(h,b,(uint)b.Length,out n,IntPtr.Zero)||n!=b.Length)Fail("write");
   if(!FlushFileBuffers(h))Fail("durable flush");return h;
  }catch {Delete(h);CloseHandle(h);throw;}
 }
 static void Delete(IntPtr h) {if(h==IntPtr.Zero)return;var b=Marshal.AllocHGlobal(4);try {Marshal.WriteInt32(b,1);if(!SetFileInformationByHandle(h,4,b,4))Fail("evidence cleanup disposition");}finally {Marshal.FreeHGlobal(b);}}
 static void Rename(IntPtr h,string p) {
  byte[] name=Encoding.Unicode.GetBytes(p);int ro=IntPtr.Size==8?8:4,lo=ro+IntPtr.Size,no=lo+4;
  int size=no+name.Length+2;
  var b=Marshal.AllocHGlobal(size);try {
   for(int j=0;j<size;j++)Marshal.WriteByte(b,j,0);
   Marshal.WriteInt32(b,lo,name.Length);Marshal.Copy(name,0,IntPtr.Add(b,no),name.Length);
   if(!SetFileInformationByHandle(h,3,b,(uint)size))Fail("no-overwrite handle rename");
  }finally {Marshal.FreeHGlobal(b);}
 }
 static void CheckRenamed(IntPtr original,string p) {
  var h=Open(p,0x80000080,7,3,0x00200000);try {
   Info a,b;if(!GetFileInformationByHandle(original,out a))Fail("renamed source identity");b=Check(h,p,false);
   if(a.Volume!=b.Volume || a.IndexH!=b.IndexH || a.IndexL!=b.IndexL)throw new IOException("Renamed file identity changed");
  }finally {CloseHandle(h);}
 }
 static void Match(Info i,string expected) {
  string actual=i.Volume.ToString()+":"+(((ulong)i.IndexH<<32)|i.IndexL).ToString();
  if(actual!=expected)throw new IOException("Directory/file identity changed before native save");
 }
 static string Identity(Info i) {return i.Volume.ToString()+":"+(((ulong)i.IndexH<<32)|i.IndexL).ToString();}
 static string Encode(string s) {return Convert.ToBase64String(Encoding.UTF8.GetBytes(s));}
 static string Decode(string s) {return Encoding.UTF8.GetString(Convert.FromBase64String(s));}
 static List<IntPtr> Lease(string parent,string[] ids) {
  var dirs=new List<IntPtr>();try {
   string current=Path.GetPathRoot(parent);if(current.Length!=3 || current[1]!=':')throw new IOException("Only local drive paths supported");
   int index=0;var root=Open(current,0x80,3,3,0x02200000);dirs.Add(root);Match(Check(root,current,true),ids[index++]);
   foreach(string part in parent.Substring(current.Length).Split('\\')) {current=Path.Combine(current,part);var h=Open(current,0x80,3,3,0x02200000);dirs.Add(h);Match(Check(h,current,true),ids[index++]);}
   if(index!=ids.Length)throw new IOException("Recovery directory identities invalid");return dirs;
  }catch {for(int j=dirs.Count-1;j>=0;j--)CloseHandle(dirs[j]);throw;}
 }
 static IntPtr Verified(string p,string id,string hash,bool allowMissing=false) {
  var h=CreateFileW(p,0xC0010080,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
  if(h.ToInt64()==-1) {if(allowMissing && Marshal.GetLastWin32Error()==2)return IntPtr.Zero;Fail("recovery evidence open");}
  try {Match(Check(h,p,false),id);if(Hash(Read(h))!=hash)throw new IOException("Recovery file hash changed; evidence retained");return h;}catch {CloseHandle(h);throw;}
 }
 public static void Recover(string journal,string[] currentIds) {
  var dirs=Lease(Path.GetDirectoryName(journal),currentIds);IntPtr log=IntPtr.Zero,original=IntPtr.Zero,temp=IntPtr.Zero,target=IntPtr.Zero;
  try {
   log=Open(journal,0xC0010080,1,3,0x00200000);Check(log,journal,false);
   string[] v=Encoding.UTF8.GetString(Read(log)).Split('\n');
   if(v.Length!=9 || v[0]!="seedhost-save-v1")throw new IOException("Recovery journal malformed; evidence retained");
   for(int n=4;n<8;n++)if(!System.Text.RegularExpressions.Regex.IsMatch(v[n],n%2==0?"\\A[0-9]{1,10}:[0-9]{1,20}\\z":"\\A[0-9a-f]{64}\\z"))throw new IOException("Recovery metadata malformed; evidence retained");
   string p=Decode(v[1]),backup=Decode(v[2]),stage=Decode(v[3]),parent=Path.GetDirectoryName(journal);
   string nonce=Path.GetFileName(journal).Substring(".seedhost-transaction-".Length);
   if(!nonce.EndsWith(".journal"))throw new IOException("Recovery journal name invalid");nonce=nonce.Substring(0,nonce.Length-8);
   Guid parsed;if(!Guid.TryParseExact(nonce,"D",out parsed) || Path.GetFileName(backup)!=".seedhost-backup-"+nonce+".bak" || Path.GetFileName(stage)!=".seedhost-edit-"+nonce+".tmp" || Path.GetFileName(p).StartsWith(".seedhost",StringComparison.OrdinalIgnoreCase))throw new IOException("Recovery names invalid; evidence retained");
   foreach(string name in new string[]{p,backup,stage})if(!String.Equals(Path.GetDirectoryName(name),parent,StringComparison.OrdinalIgnoreCase) || Path.GetFullPath(name)!=name)throw new IOException("Recovery paths invalid; evidence retained");
   if(String.Join(",",currentIds)!=v[8])throw new IOException("Recovery directory identity changed; evidence retained");
   target=CreateFileW(p,0xC0010080,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
   if(target.ToInt64()==-1) {
    target=IntPtr.Zero;if(Marshal.GetLastWin32Error()!=2)Fail("recovery target open");
    original=Verified(backup,v[4],v[5]);temp=Verified(stage,v[6],v[7]);
    Rename(original,p);CheckRenamed(original,p);if(!FlushFileBuffers(original))Fail("recovered original flush");
   }else {
    Info i=Check(target,p,false);string id=Identity(i),hash=Hash(Read(target));
    // Missing stage is safe only for the authenticated original after cleanup.
    if(id==v[4] && hash==v[5]) {temp=Verified(stage,v[6],v[7],true);}
    else if(id==v[6] && hash==v[7]) {original=Verified(backup,v[4],v[5]);}
    else throw new IOException("Recovery target identity/hash ambiguous; evidence retained");
   }
   Delete(temp);Delete(log);
  }finally {if(target!=IntPtr.Zero)CloseHandle(target);if(temp!=IntPtr.Zero)CloseHandle(temp);if(original!=IntPtr.Zero)CloseHandle(original);if(log!=IntPtr.Zero)CloseHandle(log);for(int j=dirs.Count-1;j>=0;j--)CloseHandle(dirs[j]);}
 }
 public static void Save(string p,string expected,byte[] data,string backup,string stage,string[] ids) {
  var dirs=new List<IntPtr>();IntPtr target=IntPtr.Zero,temp=IntPtr.Zero,log=IntPtr.Zero;bool published=false,moved=false;
  try {
   string parent=Path.GetDirectoryName(p),current=Path.GetPathRoot(p);
   if(!String.Equals(Path.GetDirectoryName(backup),parent,StringComparison.OrdinalIgnoreCase) ||
      !String.Equals(Path.GetDirectoryName(stage),parent,StringComparison.OrdinalIgnoreCase) ||
      !Path.GetFileName(backup).StartsWith(".seedhost-backup-") || !Path.GetFileName(stage).StartsWith(".seedhost-edit-") || backup==stage)
    throw new IOException("Backup/stage destination must stay in the leased directory");
   if(data.Length>262144)throw new IOException("Server text too large");
   if(current.Length!=3 || current[1]!=':')throw new IOException("Only local drive paths supported");
   var parts=parent.Substring(current.Length).Split('\\');
   int index=0;var root=Open(current,0x80,3,3,0x02200000);dirs.Add(root);Match(Check(root,current,true),ids[index++]);
   foreach(string part in parts) {current=Path.Combine(current,part);var h=Open(current,0x80,3,3,0x02200000);dirs.Add(h);Match(Check(h,current,true),ids[index++]);}
   target=Open(p,0xC0010080,1,3,0x00200000);Info identity=Check(target,p,false);Match(identity,ids[index]);
   byte[] original=Read(target);if(Hash(original)!=expected)throw new IOException("Server file changed. Refresh before saving.");
   if(!FlushFileBuffers(target))Fail("original backup flush");
   temp=Create(stage,data);
   Info again=Check(target,p,false);
   if(identity.Volume!=again.Volume || identity.IndexH!=again.IndexH || identity.IndexL!=again.IndexL)throw new IOException("File identity changed");
   string nonce=Path.GetFileName(backup).Substring(".seedhost-backup-".Length);nonce=nonce.Substring(0,nonce.Length-4);
   string journal=Path.Combine(parent,".seedhost-transaction-"+nonce+".journal");
   string record=String.Join("\n",new string[]{"seedhost-save-v1",Encode(p),Encode(backup),Encode(stage),Identity(identity),Hash(original),Identity(Check(temp,stage,false)),Hash(data),String.Join(",",new List<string>(ids).GetRange(0,ids.Length-1).ToArray())});
   log=Create(journal,Encoding.UTF8.GetBytes(record));
   Rename(target,backup);moved=true;CheckRenamed(target,backup);
   if(!FlushFileBuffers(target))Fail("backup flush");
   Rename(temp,p);published=true;
   CheckRenamed(temp,p);if(!FlushFileBuffers(temp))Fail("published flush");
  }catch(Exception failure) {
   if(moved && !published) {try {Rename(target,p);moved=false;}catch(Exception rollback) {throw new IOException(failure.Message+"; rollback refused; recovery evidence retained: "+rollback.Message,failure);}}
   throw;
  }finally {
   if(published || !moved) {Delete(log);if(!published)Delete(temp);}
   if(log!=IntPtr.Zero)CloseHandle(log);if(temp!=IntPtr.Zero)CloseHandle(temp);if(target!=IntPtr.Zero)CloseHandle(target);
   for(int j=dirs.Count-1;j>=0;j--)CloseHandle(dirs[j]);
  }
 }
}
'@
$p=([Console]::In.ReadToEnd() | ConvertFrom-Json)
if ($p.journal) { [Writer]::Recover([string]$p.journal,[string[]]$p.identities) }
else { [Writer]::Save([string]$p.file,[string]$p.hash,[Convert]::FromBase64String([string]$p.data),[string]$p.backup,[string]$p.stage,[string[]]$p.identities) }
[Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Out.WriteLine((@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress));exit 1 }
`;

export async function windowsServerWrite(file: string, text: string, hash: string, backup: string, stage: string): Promise<void> {
  return nativeOperation(file, { file, hash, data: Buffer.from(text).toString('base64'), backup, stage }, true);
}
export async function windowsServerRecover(journal: string): Promise<void> {
  return nativeOperation(journal, { journal }, false);
}
async function nativeOperation(file: string, payload: Record<string, unknown>, includeFile: boolean): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Safe server save unavailable on this platform');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const ancestors: string[] = [];
  let current = path.parse(file).root;
  ancestors.push(current);
  for (const part of path.dirname(file).slice(current.length).split(path.sep)) {
    current = path.join(current, part); ancestors.push(current);
  }
  const identities: string[] = [];
  for (const target of includeFile ? [...ancestors, file] : ancestors) {
    const stat = await lstat(target, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('Links/junctions refused before native save');
    identities.push(stat.dev.toString() + ':' + stat.ino.toString());
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script.replace(/^[ \t]+/gm, ''), 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
        let result: { ok?: boolean; error?: string };
        try { result = JSON.parse(stdout.trim()); } catch { reject(new Error('Safe save helper failed; refresh the file before retrying. ' + (error?.message || '').slice(0, 240))); return; }
        if (error || result.ok !== true) { reject(new Error(String(result.error || error?.message || 'Safe save helper refused').slice(0, 500))); return; }
        resolve();
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ ...payload, identities }).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
  });
}
