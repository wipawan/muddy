/*
 * Server-side JS - Main file
 */

// Environment configurables
var port = 3000;
var _filepwd = __dirname + '/.private/pwd';
var _fileindex = __dirname + '/public/index.html';
var _fileregister = __dirname + '/public/register.html';
var _filemaps = __dirname + '/json/maps.json';
var _fileusers = __dirname + '/json/users.json';

// Dependencies
var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var fs = require('fs');
var User = require(__dirname + '/User.js');
app.use(express.static(__dirname + '/public'));

// Globals
var maps = {};
var users = {};
var socketid = {};
var mobs = require(__dirname + '/Mob.js');

// Listen to <port>
http.listen(port, function(){
	console.log('listening on *:' + port);
});

// Route handler
app.get('/',function(req, res){
	res.sendfile(_fileindex);
});

app.get('/register',function(req, res){
	res.sendfile(_fileregister);
});

//===============================
// Read data files asynchronously
//===============================

fs.readFile(_filemaps, 'utf8', function (err, data) {
	if(err) {
		console.log('Map file error: ' + err);
		return;
	}
	maps = JSON.parse(data);
	
	//add mobs to maps
	for(var i=0; i<mobs.length; i++) {
		(maps[mobs[i].at].mobs).push(mobs[i]);
		//console.dir(maps[mobs[i].at]);
		//console.log(maps[mobs[i].at].mobs[0].isDead);
	}
});

fs.readFile(_fileusers, 'utf8', function (err, data) {
	if(err) {
		console.log('User file error: ' + err);
		return;
	}
	var obj = JSON.parse(data);
	
	for(var key in obj) {
		users[key] = new User(obj[key]);
	}
});


//=========
// Session
//=========
io.on('connection', function(socket){
	var player;
	
	// When user first connects
	socket.join(socket.id);
	socket.join('/hints');
	socket.join('/all');
	console.log('user ' + socket.id + ' connected');
	io.to(socket.id).emit('socketid', socket.id);
	

	//==============================================
	// Event handlers for events triggered by client
	//==============================================

	// Request a login
	socket.on('reqlogin', function(login){
		
		// if username already exists in database
		if(users.hasOwnProperty(login.username)){
			if(verifyPassword(login, socket.id) === true){
				//update user's socketid
				users[login.username].socketid = socket.id;

				//update users file
				updateUsersFile();

				//assign globals
				socketid[socket.id] = login.username;
				player = users[login.username];

				//join own room
				socket.join(login.username);

				//trigger events
				console.log(login.username + ' has logged in');
				io.to(socket.id).emit('loginverified', login.username);
				io.to(socket.id).emit('message', 'Welcome ' + login.username + '!');
				
				//trigger map refresh every 1 second
				setInterval(function() {
					io.to(socket.id).emit('map', maps[player.at]);
				}, 1000);

				//start player recovery
				player.recover();
				//update player stats every 1 second
				setInterval(function() {
					io.to(socket.id).emit('stats', player);
				}, 1000);
			}
			else{
				//wrong password
				io.to(socket.id).emit('loginfailed');
			}
		}
		else{
			//user does not exist
			io.to(socket.id).emit('loginfailed');
		}
	});

	// Register a new user
	socket.on('register', function(login){
		// if username already exists in database
		if(users.hasOwnProperty(login.username)){
			io.to(socket.id).emit('regfailed');
		}
		else {
			//create the new user
			users[login.username] = new User(login.username, socket.id);
			console.dir(users[login.username]);

			//update users file
			updateUsersFile();

			//update pwd file
			var pwds = {};
			fs.readFile(_filepwd, 'utf8', function (err, data) {
				if(err) {
					console.log('Password file error: ' + err);
					return;
				}
				pwds = JSON.parse(data);
				pwds[login.username] = login.password;

				fs.writeFile(_filepwd, JSON.stringify(pwds, null, 4), function(err) {
					if(err) {
						console.log('Password file error: ' + err);
					}
					else {
						console.log('Password save');
					}
				});
			});

			//trigger event to redirect client back to / to login
			io.to(socket.id).emit('regpass');
		}
	});

	
	// Add msg.from and send to msg.to
	socket.on('chat', function(msg) {
		msg.from = player.name;
		io.to(msg.to).emit('chat', msg);
	});

	// Boundary checking then move player
	socket.on('move', function(direction) {
		if(maps[player.at].exits.hasOwnProperty(direction[0])) {
			player.at = maps[player.at].exits[direction[0]];
			io.to(socket.id).emit('map', maps[player.at]);
			//console.log(socketid[socket.id] + ' moves: ' + direction + ' to ' + player.at);
		}
		else {
			io.to(socket.id).emit('message', 'You cannot move in that direction');
		}
	});

	// Combat
	socket.on('fight', function(data){
		//check if target exists in map
		var mobsInMap = maps[player.at].mobs.filter(function(mob){return mob.name === data.target});

		if(mobsInMap.length > 0){
			//assign target as the Mob object not just its name
			var target = mobsInMap[0];

			if(target.isDead === false){
				//start target recovery
				target.recover();

				var playerCombat = setInterval(function(){
					var dmg = player.damageOther(target, data.skill);
					var msg;
					if(dmg === 0){
						msg = 'You missed ' + target.name + '!';
					}
					else{
						msg = 'You ' + data.skill + ' ' + target.name + ' for ' + dmg + ' damage!';
					}
					io.to(socket.id).emit('message', msg);
				}, player.spd);
				
				var targetCombat = setInterval(function(){
					var dmg = target.damageOther(player);	//using target's default skill
					var msg;
					if(dmg === 0){
						msg = target.name + ' missed you!';
					}
					else{
						msg = target.name + ' ' + target.defaultSkill + 's you for ' + dmg + ' damage!';
					}
					io.to(socket.id).emit('message', msg);
				}, target.spd);

				var hpCheck = setInterval(function(){
					io.to(socket.id).emit('combatInfo', {'playername': player.name, 'playerhp': player.hp, 'targetname': target.name, 'targethp': target.hp});
					console.log('player hp: ' + player.hp + ' target hp: ' + target.hp);

					//NOTE: assuming player does not die...

					//death
					if(target.isDead === true) {
						//stop fighting dammit
						clearInterval(targetCombat);
						clearInterval(playerCombat);
						clearInterval(hpCheck);

						target.onDeath(maps[target.at]);
						target.stopRecovery();
						console.dir(maps[target.at]);
						io.to(socket.id).emit('message', 'Victory! You have defeated ' + target.name);
					}
				}, 500);
			}
		}
		else {
			console.log('target missing');
			io.to(socket.id).emit('message', 'Target missing');
		}
	});

	// Save user data on disconnect
	socket.on('disconnect', function() {
		console.log('user ' + socket.id + ' disconnected');
		updateUsersFile();
	});

	// Any other input, echo back
	socket.on('command', function(msg){
		console.log(socket.id + ' sends: ' + msg);
		io.to(socket.id).emit('message', msg);
	});
});

//=======
// Other
//=======

// Hashing function
var hash = function(str) {
  var hash = 0, i, chr, len;
  if (str.length == 0) return hash;
  for (i = 0, len = str.length; i < len; i++) {
    chr   = str.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash;
};

// Use synchronous file read to verify password
var verifyPassword = function(login, id) {
	var pwds = {};
	pwds = JSON.parse(fs.readFileSync(_filepwd, 'utf8'));

	if(pwds.hasOwnProperty(login.username)) {
		var pwd = id + pwds[login.username];
		pwd = String(hash(pwd));

		if(pwd === login.password) {
			return true;
		}
	}
	return false;
};


//update users file
var updateUsersFile = function() {
	var usersToJSON = {};

	for(var user in users) {
		usersToJSON[user] = users[user].toJSON();
	}

	fs.writeFile(_fileusers, JSON.stringify(usersToJSON, null, 4), function(err) {
		if(err) {
			console.log('User file error: ' + err);
		}
		else {
			console.log('Users.JSON save to ' + _fileusers);
		}
	});
}

setInterval(function() {
	io.to('/hints').emit('message', 'Welcome to muddy! Type @help for help');
}, 60000);