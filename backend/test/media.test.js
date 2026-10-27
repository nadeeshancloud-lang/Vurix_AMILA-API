const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateUrl,publicAddress,safeError}=require('../src/services/extraction.service');
const {sanitizeFilename}=require('../src/controllers/media.controller');
test('public providers accepted after DNS validation',async()=>{assert.equal(await validateUrl('https://www.youtube.com/watch?v=123',async()=>[{address:'142.250.1.1'}]),'https://www.youtube.com/watch?v=123')});
test('metadata service, loopback and private addresses rejected',async()=>{for(const address of ['127.0.0.1','169.254.169.254','10.1.1.1','192.168.1.1','172.16.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicAddress(address),false);await assert.rejects(validateUrl('https://local.invalid/video',async()=>[{address:'10.0.0.1'}]))});
test('credentials and non-web schemes rejected',async()=>{await assert.rejects(validateUrl('https://user:pass@example.com'));await assert.rejects(validateUrl('file:///etc/passwd'))});
test('error URLs redacted',()=>assert.equal(safeError('failed https://cdn.example/video?signature=secret'),'failed [link]'));
test('filename cannot inject a header or directory',()=>{assert.equal(sanitizeFilename('a/b\r\nX:yes','mp4'),'a_b__X_yes.mp4');assert.equal(sanitizeFilename('Video','mp3'),'Video.mp3')});
