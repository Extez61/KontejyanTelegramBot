'use strict';
const path=require('node:path');
const logs=path.join(__dirname,'logs');
require('node:fs').mkdirSync(logs,{recursive:true,mode:0o700});
module.exports={apps:[{
 name:'ebot',cwd:__dirname,script:path.join(__dirname,'bot.js'),
 interpreter:process.execPath,exec_mode:'fork',instances:1,
 autorestart:true,restart_delay:5000,min_uptime:'10s',max_restarts:10,
 out_file:path.join(logs,'bot-out.log'),error_file:path.join(logs,'bot-error.log'),merge_logs:true,
 kill_timeout:10000,time:false,env:{NODE_ENV:'production'}
}]};
