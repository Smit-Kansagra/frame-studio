// Isolated base-version proof. Never opens the installed workspace.
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { DatabaseSync } from 'node:sqlite'
const folder=await mkdtemp(path.join(os.tmpdir(),'frame-base-reopen-'))
for(const name of ['database','errors']){const source=execFileSync('git',['show',`HEAD:electron/storage/${name}.cts`],{encoding:'utf8'});await writeFile(path.join(folder,name+'.cjs'),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)}
const {openDatabase,SCHEMA_VERSION}=createRequire(import.meta.url)(path.join(folder,'database.cjs'))
const dbFile=path.join(folder,'base.sqlite');let db=await openDatabase(dbFile);assert.equal(db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);db.close()
db=await openDatabase(dbFile);db.close();console.log('PASS base HEAD: fresh schema and ordinary reopen.')
await copyFile(dbFile,path.join(folder,'malformed.sqlite'))
let malformed=new DatabaseSync(path.join(folder,'malformed.sqlite'));malformed.exec('PRAGMA user_version=1');malformed.close();await assert.rejects(openDatabase(path.join(folder,'malformed.sqlite')),/already exists/);console.log('PASS reproduced base HEAD failure when newer tables remain but test forces schema 1.')
db=new DatabaseSync(dbFile);db.exec('PRAGMA foreign_keys=OFF');const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();for(const {name}of tables)if(!['assets','schema_migrations','import_jobs'].includes(name))db.exec('DROP TABLE "'+name.replaceAll('"','""')+'"');db.exec('DELETE FROM schema_migrations WHERE version>=2; PRAGMA user_version=1');db.close()
db=await openDatabase(dbFile);assert.equal(db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);db.close();db=await openDatabase(dbFile);db.close();console.log('PASS base HEAD: actual schema-1 upgrade and subsequent reopen. Database path: '+folder)
