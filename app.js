#!/opt/local/agents/smart-key-manager/local/bin/node

// Smart Key Manager... manages user ssh keys for gitosis

var AGENT_NAME = 'smart-key-manager';
var VERSION = '0.01';

var sys   = require('sys');
var fs    = require('fs'); 
var path  = require('path');
var path  = require('path');
var ini   = require('ini');
var amqp  = require('amqp');
require('./helper');

// Path to GITOSIS.conf
var gitosisConfig = path.join(__dirname, "gitosis.conf");

var currentAMQPConnection;
var hostname;
sys.exec("hostname", function(err, stdout, stderr){
    var tmp = stdout.replace(/(?:^\s+|\s+$)/g, '');
    sys.puts(AGENT_NAME + " version " + VERSION + " starting on host '" + tmp +"'");
    hostname = tmp;
});

var connectionCloseHandle = function (exception) { 
  if (exception) { 
      sys.puts("[ERROR] connection unexpectedly closed: " + exception);
  }
  sys.puts("[INFO] Disconnected, attempting to reconnect");
  setTimeout(function(){
    setup_connection();
  }, 5000);
};

var connectionReadyHandle = function(connection) {
  sys.puts("[INFO] connected to " + connection.serverProperties.product);  
  var config = connection.config;
  
  var exchange = connection.exchange(config.amqp.repository_key_registration_exchange);  
  var queue = connection.queue(AGENT_NAME);
  sys.puts("[INFO] using QUEUE " + AGENT_NAME);  
  
  queue.subscribe(function (message) {
    message.addListener('data', function (d) {        
      if (d) {
        try {
          data = eval("("+d+")");
          var user = data['user'];
          var key = data['key'];

          try {
            add_user_key(user, key, connection.config);
          } catch(e){
            sys.debug("[ERROR] Can't add user key: " + e);
          }

        } catch(e){
          sys.debug("[ERROR] Failed to decode json object");
        }
      }      
    });

    // Remove message from queue, once it is processed
    message.addListener('end', function () { message.acknowledge(); });
  });
};

var setup_connection = function(prev, curr) {

  // If the times are the same, we just drop out... otherwise we continue and
  // attempt to connect.
  if(curr && prev){
    if(curr.mtime >= prev.mtime){
        return;
    } else {
        sys.puts("[INFO] config changed, reconnecting");
    }
  } else {
    // This is what happens during initial start up
    sys.puts("[INFO] Starting up...");
  }

  fs.readFile(gitosisConfig, function(e, d) {
    if(e){
      sys.puts("[WARNING] Unable to read configuration file: " + gitosisConfig + " : " + e);
    } else {
      var config;
      
      try {
        config = ini.parse(d);
      } catch(err) {
        throw new Error("[ERROR] Unable to parse config file '" + gitosisConfig + "': " + err);
      }

      if(currentAMQPConnection){
        // This is an expected close event so we don't want to attempt reconnect on the
        // same handle
        currentAMQPConnection.removeListener('close', connectionCloseHandle);
        currentAMQPConnection.close();
        currentAMQPConnection = null;
      }
      var connection = amqp.createConnection({port:Number(config.amqp.port), host:config.amqp.host});
      connection.config = config;
      connection.addListener('close', connectionCloseHandle );
      connection.addListener('ready', connectionReadyHandle.bind(this,connection));  
      currentAMQPConnection = connection;
    }
  });
};

// We want to be able to change configuration on the fly, so we may need to reconnect, etc.
fs.watchFile(gitosisConfig, { persistent: true, interval: 10000 }, setup_connection);
setup_connection();

var add_user_key = function(user, key, config) {
    // 1 check and remove email from key

    var username = key.split("==")[1];
    if (username !== user) {
      key = key.split("==")[0] + "== " + user; 
    }
    
    var keytmp = path.join(__dirname,"gitosis-admin");
    
    // git@yourgitserver.local:gitosis-admin.git /opt/local/agents/smart-key-manager
    cloneUri = config.rsp['git_user'] + "@" + config.rsp['git_server'] + ":gitosis-admin.git";

    path.exists(keytmp, function (exists) {
      if (!exists) {
        cmd = "/opt/local/bin/git clone " + cloneUri;
      } else {
        cmd = "/opt/local/bin/git pull";
      }
      
      executeCmd("(cd "+ __dirname +"; " + cmd + ")",function() {
        commitFile(path.join(keytmp,"keydir") , user, key);
      });                  
    });    

};

var commitFile = function(keytmp, user, key) {
  
  var pubPath = path.join(keytmp, user + ".pub");
  
  path.exists(keytmp, function (exists) {
  
    if (exists) {
      // Does a key already exist for this user?
      path.exists(pubPath, function (exists) {
        if (exists) {
          sys.puts("[INFO] Overriding existing key file for user");
        } else {
          sys.puts("[INFO] New User (" + user + ") key added to system.");
        }
  
        fs.writeFile(pubPath, key, function (err) {
          if (err) throw err;
          
          executeCmd("(cd "+keytmp+ "; /opt/local/bin/git pull )",function() {
            executeCmd("(cd "+keytmp+ "; /opt/local/bin/git add " + pubPath + ") ",function() {
              executeCmd("(cd "+keytmp+ "; /opt/local/bin/git commit -am 'Adding key for user "+user+"') ",function() {
                sys.puts("[INFO] Complete");
              });          
            });
          });
  
        });          
      });
      
    } else {
      sys.puts("[ERROR] no key directory created - (" + keytmp + ")");
    }
  });  
}

var executeCmd = function(cmd, callback) {
  sys.exec(cmd, function (err, stdout, stderr) {
    if (err) {
      sys.puts("[ERROR] Could not run command '" + cmd + "'" + ": " + err);
    } else {
      sys.puts("[INFO] Done processing command " + cmd);
    }
    
    if (typeof callback == 'function') callback();    
  });  
}
