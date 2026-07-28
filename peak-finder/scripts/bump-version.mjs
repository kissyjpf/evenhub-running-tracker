import { readFileSync, writeFileSync } from 'fs'

const path = new URL('../app.json', import.meta.url).pathname
const app = JSON.parse(readFileSync(path, 'utf8'))

const [major, minor, patch] = app.version.split('.').map(Number)
app.version = `${major}.${minor}.${patch + 1}`

writeFileSync(path, JSON.stringify(app, null, 2) + '\n')
console.log(`version bumped → ${app.version}`)
