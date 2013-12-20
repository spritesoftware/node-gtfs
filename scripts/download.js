var request = require('request')
  , exec = require('child_process').exec
  , fs = require('fs')
  , path = require('path')
  , csv = require('csv')
  , async = require('async')
  , unzip = require('unzip')
  , downloadDir = 'downloads'
  , Db = require('mongodb').Db
  , _ = require('underscore')
  , q;

//load config.js
try {
  var config = require('../config.js');
} catch (e) {
  handleError(new Error('Cannot find config.js'));
}


var GTFSFiles = [
  {
      fileNameBase: 'agency'
    , collection: 'agencies'
  },
  {
      fileNameBase: 'calendar_dates'
    , collection: 'calendardates'
  },
  {
      fileNameBase: 'calendar'
    , collection: 'calendars'
  },
  {
      fileNameBase: 'fare_attributes'
    , collection: 'fareattributes'
  },
  {
      fileNameBase: 'fare_rules'
    , collection: 'farerules'
  },
  {
      fileNameBase: 'feed_info'
    , collection: 'feedinfos'
  },
  {
      fileNameBase: 'frequencies'
    , collection: 'frequencies'
  },
  {
      fileNameBase: 'routes'
    , collection: 'routes'
  },
  {
      fileNameBase: 'stop_times'
    , collection: 'stoptimes'
  },
  {
      fileNameBase: 'stops'
    , collection: 'stops'
  },
  {
      fileNameBase: 'transfers'
    , collection: 'transfers'
  },
  {
      fileNameBase: 'trips'
    , collection: 'trips'
  },
  {
      fileNameBase: 'shapes'
    , collection: 'shapes'
  }
];

if (typeof Number.prototype.toRad == 'undefined') {
  Number.prototype.toRad = function() {
    return this * Math.PI / 180;
  }
}

if (typeof Number.prototype.toDeg == 'undefined') {
  Number.prototype.toDeg = function() {
    return this * 180 / Math.PI;
  }
}

if (typeof Number.prototype.toPrecisionFixed == 'undefined') {
  Number.prototype.toPrecisionFixed = function(precision) {
    
    // use standard toPrecision method
    var n = this.toPrecision(precision);
    
    // ... but replace +ve exponential format with trailing zeros
    n = n.replace(/(.+)e\+(.+)/, function(n, sig, exp) {
      sig = sig.replace(/\./, '');       // remove decimal from significand
      l = sig.length - 1;
      while (exp-- > l) sig = sig + '0'; // append zeros from exponent
      return sig;
    });
    
    // ... and replace -ve exponential format with leading zeros
    n = n.replace(/(.+)e-(.+)/, function(n, sig, exp) {
      sig = sig.replace(/\./, '');       // remove decimal from significand
      while (exp-- > 1) sig = '0' + sig; // prepend zeros from exponent
      return '0.' + sig;
    });
    
    return n;
  }
}

if(!config.agencies){
  handleError(new Error('No agency_key specified in config.js\nTry adding \'capital-metro\' to the agencies in config.js to load transit data'));
  process.exit();
}

//open database and create queue for agency list
Db.connect(config.mongo_url, {w: 1}, function(err, db) { 
  q = async.queue(downloadGTFS, 1);
  //loop through all agencies specified
  //If the agency_key is a URL, download that GTFS file, otherwise treat 
  //it as an agency_key and get file from gtfs-data-exchange.com
  config.agencies.forEach(function(item){
    if(typeof(item) == 'string') {
      var agency = {
              agency_key: item
            , agency_url: 'http://www.gtfs-data-exchange.com/agency/' + item + '/latest.zip'
          }
    } else {
      var agency = {
              agency_key: item.agency_key
            , agency_url: item.url
          }
    }

    if(!agency.agency_key || !agency.agency_url) {
      handleError(new Error('No URL or Agency Key provided.'));
    }

    q.push(agency);
  });

  q.drain = function(e) {
    console.log('All agencies completed (' + config.agencies.length + ' total)');
    db.close();
    process.exit();
  }


  function downloadGTFS(task, cb){
    var agency_key = task.agency_key
      , agency_bounds = {sw: [], ne: []}
      , agency_url = task.agency_url
      , last_shape_id = '~INVALID~'
      , last_shape_loc
      , last_shape_sequence_no
      , shape_distance = 0
      , assumedVelocity = 50;

    console.log('Starting ' + agency_key);

    async.series([
      cleanupFiles,
      downloadFiles,
      removeDatabase,
      importFiles,
      postProcess,
      cleanupFiles
    ], function(e, results){
      console.log( e || agency_key + ': Completed')
      cb();
    });


    function cleanupFiles(cb){
      //remove old downloaded file
  		exec( (process.platform.match(/^win/) ? 'rmdir /Q /S ' : 'rm -rf ') + downloadDir, function(e, stdout, stderr) {
  		  try {
    			//create downloads directory
    			fs.mkdirSync(downloadDir);
    			cb();
  		  } catch(e) {
          if(e.code == 'EEXIST') {
            cb();
          } else {
            handleError(e);
          }
        }
  		});
    }
    

    function downloadFiles(cb){
      //do download
      request(agency_url, processFile).pipe(fs.createWriteStream(downloadDir + '/latest.zip'));

      function processFile(e, response, body){
        if(response && response.statusCode != 200){ cb(new Error('Couldn\'t download files')); }
        console.log(agency_key + ': Download successful');
  	
        fs.createReadStream(downloadDir + '/latest.zip')
          .pipe(unzip.Extract({ path: downloadDir }).on('close', cb))
          .on('error', handleError);
      }
    }


    function removeDatabase(cb){
      //remove old db records based on agency_key
      async.forEach(GTFSFiles, function(GTFSFile, cb){
        db.collection(GTFSFile.collection, function(e, collection){
          collection.remove({ agency_key: agency_key }, {safe: true}, cb);
        });
      }, function(e){
          cb(e, 'remove');
      });
    }


    function importFiles(cb){
      //Loop through each file and add agency_key
      async.forEachSeries(GTFSFiles, function(GTFSFile, cb){
        if(GTFSFile){
          var filepath = path.join(downloadDir, GTFSFile.fileNameBase + '.txt');
          if (!fs.existsSync(filepath)) return cb();
          console.log(agency_key + ': ' + GTFSFile.fileNameBase + ' Importing data');
          db.collection(GTFSFile.collection, function(e, collection){
            csv()
              .from.path(filepath, {columns: true})
              .on('record', function(line, index){
                 //remove null values
                for(var key in line){
                  if(line[key] === null){
                    delete line[key];
                  }
                }
                
                //add agency_key
                line.agency_key = agency_key;

                //convert fields that should be int
                if(line.stop_sequence){
                  line.stop_sequence = parseInt(line.stop_sequence, 10);
                }
                if(line.direction_id){
                  line.direction_id = parseInt(line.direction_id, 10);
                }

                //make lat/lon array
                if(line.stop_lat && line.stop_lon){
                  line.loc = [parseFloat(line.stop_lon), parseFloat(line.stop_lat)];
                  
                  //Calulate agency bounds
                  if(agency_bounds.sw[0] > line.loc[0] || !agency_bounds.sw[0]){
                    agency_bounds.sw[0] = line.loc[0];
                  }
                  if(agency_bounds.ne[0] < line.loc[0] || !agency_bounds.ne[0]){
                    agency_bounds.ne[0] = line.loc[0];
                  }
                  if(agency_bounds.sw[1] > line.loc[1] || !agency_bounds.sw[1]){
                    agency_bounds.sw[1] = line.loc[1];
                  }
                  if(agency_bounds.ne[1] < line.loc[1] || !agency_bounds.ne[1]){
                    agency_bounds.ne[1] = line.loc[1];
                  }
                }

                //Convert shape points
                if(line.shape_pt_lat && line.shape_pt_lon){

                  line.shape_pt_sequence = parseInt(line.shape_pt_sequence, 10);

                  line.loc = [parseFloat(line.shape_pt_lon), parseFloat(line.shape_pt_lat)];

                  delete line.shape_pt_lat;
                  delete line.shape_pt_lon;

                  if(last_shape_id === line.shape_id){

                    var distance = calculateInterCoordDistance(
                                                last_shape_loc[1],
                                                last_shape_loc[0],
                                                line.loc[1],
                                                line.loc[0]);

                    var backBearing = calculateBearing(
                                                line.loc[1],
                                                line.loc[0],
                                                last_shape_loc[1],
                                                last_shape_loc[0]);

                    shape_distance += distance;

                    line.time_offset = Math.floor(((shape_distance / assumedVelocity) * 3600));  // Seconds from start of route
                    line.back_bearing = backBearing;

                  }
                  else
                  {
                    if(last_shape_id !== '~INVALID~'){
                        var statsLine = new Object();

                        statsLine.shape_id = line.shape_id;
                        statsLine.total_time = Math.floor(((shape_distance / assumedVelocity) * 3600));  // Seconds from start of route

                        db.collection('shapestats', function(e, shapesStatsCollection){
                            shapesStatsCollection.insert(statsLine, function(e, inserted) {
                                if(e) { handleError(e); }
                            });
                        });
                    }
                    shape_distance = 0;
                    line.time_offset = 0;
                    line.back_bearing = -1;
                  }

                  last_shape_id = line.shape_id;
                  last_shape_loc = line.loc;
                  last_shape_sequence_no = line.shape_pt_sequence;

                }

                //insert into db
                collection.insert(line, function(e, inserted) {
                    if(e) { handleError(e); }
                });

            })
              .on('end', function(count){
                cb();
              })
              .on('error', handleError);
          });
        }
      }, function(e){
        cb(e, 'import');
      });
    }

    //Return distance between 2 coords in km's
    function calculateInterCoordDistance(lat1, lon1, lat2, lon2){
      var R = 6371; // Earth's radius in km

      var lat1 = lat1.toRad(), lon1 = lon1.toRad();
      var lat2 = lat2.toRad(), lon2 = lon2.toRad();
      var dLat = lat2 - lat1;
      var dLon = lon2 - lon1;

      var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1) * Math.cos(lat2) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
      var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      var d = R * c;
      return d;

    }

    // Calculate the decimal bearing between two decimal coordinates
    function calculateBearing(lat1, lon1, lat2, lon2){
      var dLon = (lon2-lon1).toRad();

      lat1 = lat1.toRad(), lat2 = lat2.toRad();

      var dPhi = Math.log(Math.tan(lat2/2+Math.PI/4)/Math.tan(lat1/2+Math.PI/4));

      if (Math.abs(dLon) > Math.PI) dLon = dLon>0 ? -(2*Math.PI-dLon) : (2*Math.PI+dLon);

      var brng = Math.atan2(dLon, dPhi);
      return (brng.toDeg()+360) % 360;
    }


    function postProcess(cb){
      console.log(agency_key + ':  Post Processing data');

      async.series([
          agencyCenter
        , longestTrip
      ], function(e, results){
        cb();
      });
    }


    function agencyCenter(cb){
      var agency_center = [
          (agency_bounds.ne[0] - agency_bounds.sw[0])/2 + agency_bounds.sw[0]
        , (agency_bounds.ne[1] - agency_bounds.sw[1])/2 + agency_bounds.sw[1]
      ];

      db.collection('agencies')
        .update({agency_key: agency_key}, {$set: {agency_bounds: agency_bounds, agency_center: agency_center}}, {safe: true}, cb);
    }


    function longestTrip(cb){
      /*db.trips.find({agency_key: agency_key}).for.toArray(function(e, trips){
          async.forEach(trips, function(trip, cb){
            db.collection('stoptimes', function(e, collection){

            });
            console.log(trip);
            cb();
          }, cb);
        });
      });*/
      cb();
    }
  }
});


function handleError(e) {
  console.error(e || 'Unknown Error');
  process.exit(1)
};
