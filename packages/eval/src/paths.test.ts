import { describe,expect,it } from 'vitest';
import { assertOutputPaths,exportPaths,jsonOutput } from './paths';
describe('source preservation',()=>{
  it('rejects a render sidecar that would replace its master input',()=>{expect(()=>assertOutputPaths(exportPaths('master.bmp'),['master.json'])).toThrow('overwrite');});
  it('protects configuration files and duplicate derived outputs',()=>{
    expect(()=>assertOutputPaths(exportPaths('profile'),['design.json','profile.json'])).toThrow('overwrite');
    expect(()=>assertOutputPaths(['a.json','./a.json'],[])).toThrow('same file');
  });
  it('requires explicit JSON output suffixes and safely handles extensionless inputs',()=>{
    expect(()=>jsonOutput('in.png','foo','master')).toThrow('.json');
    expect(jsonOutput('source',undefined,'master')).toBe('source.master.json');
    if(process.platform==='win32')expect(()=>assertOutputPaths(['MASTER.JSON'],['master.json'])).toThrow('overwrite');
  });
});
