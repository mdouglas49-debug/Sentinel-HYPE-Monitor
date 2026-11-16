// Versioned, simulation-only checkpoints. Never force-push: conflicts fail closed.
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateJournal} from './paper-journal.mjs';
const ref = 'refs/heads/paper-state';
function git(args, input, maxBuffer=1024*1024) {
  return execFileSync('git', args, {input, maxBuffer, encoding:'utf8', stdio:['pipe','pipe','pipe']}).trim();
}
export function restoreState() {
  // ls-remote failures must not be interpreted as an empty journal.
  const remote = git(['ls-remote', '--refs', 'origin', ref]);
  if (!remote) { writeFileSync('.paper-state-base', ''); return false; }
  const base = remote.split(/\s/)[0];
  git(['fetch', '--no-tags', 'origin', base]);
  writeFileSync('.paper-state-base', base);
  const content = git(['show', `FETCH_HEAD:paper-journal.json`], undefined, 256*1024*1024);
  validateJournal(JSON.parse(content));
  mkdirSync('previous-journal', {recursive:true});
  writeFileSync('previous-journal/paper-journal.json', content);
  console.log('Restored durable simulation journal.');
  return true;
}
export function saveState() {
  const content = readFileSync('paper-journal.json', 'utf8');
  validateJournal(JSON.parse(content));
  const remote = git(['ls-remote', '--refs', 'origin', ref]);
  const parent = remote ? remote.split(/\s/)[0] : null;
  if (readFileSync('.paper-state-base', 'utf8') !== (parent || '')) throw Error('Paper state changed since restore; refusing to overwrite it.');
  if (parent) git(['fetch', '--no-tags', 'origin', ref]);
  const blob = git(['hash-object', '-w', '--stdin'], content);
  const tree = git(['mktree'], `100644 blob ${blob}\tpaper-journal.json\n`);
  const commit = git(['-c','user.name=Sentinel Paper Journal','-c','user.email=sentinel-paper@users.noreply.github.com',
    'commit-tree', tree, ...(parent ? ['-p',parent] : []), '-m','Save simulation-only paper checkpoint']);
  git(['push','origin',`${commit}:${ref}`]);
  console.log('Saved durable simulation journal.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'restore') {
    if (!restoreState()) await import('./restore-paper-journal.mjs');
  } else if (process.argv[2] === 'save') saveState();
  else throw Error('Use restore or save.');
}
