//Wait for MongoDB and Elasticsearch to come online
var waitOn = require('wait-on'),
    opts = {
        resources: [
            'tcp:127.0.0.1:27017',
            'tcp:127.0.0.1:9200'
        ]
    };
console.log('Waiting for MongoDB and Elasticsearch');
waitOn(opts, function (err) {
    var express = require('express');
    var path = require('path');
    var confParser = require('./lib/configParser');
    var middlewares = require('./lib/middleware');
    var common = require('./lib/common');
    var mongojs = require('mongojs');
    var methodOverride = require('method-override');

    var app = module.exports = express();

    try {
        var config = require(path.resolve(__dirname, './config/server.json'));
        config.es = confParser.parseSync(path.resolve(__dirname, './config/elasticsearch.cfg'));
        config.mongo = confParser.parseSync(path.resolve(__dirname, './config/mongo.cfg'));
    } catch (Exception) {
        process.stdout.write('Missing configuration file\n' + Exception + '\n');
        process.exit(1);
    }

    app.set('app.config', config);

    app.set('es.connection.string', function(node) {
        return common.getElasticSearchEndpoint(
            config.es.elastic_scheme,
            config.es.elastic_host,
            config.es.elastic_port,
            config.es.elastic_index,
            node
        );
    });

    app.set('mongo.connection.string', function() {
        return common.getMongoConnectionString(
            config.mongo.mongo_host,
            config.mongo.mongo_port,
            config.mongo.mongo_user,
            config.mongo.mongo_pass,
            config.mongo.mongo_database
        );
    });

    app.set('mongodb', mongojs(app.get('mongo.connection.string')()));

    app.get('mongodb').runCommand({ping:1}, function(err, res) {
        if(!err && res.ok) {
            console.log("Connected to mongodb " + app.get('mongo.connection.string')() + "\n");
        } else {
            process.stdout.write('Cant connect to mongodb using following connection string: ' + app.get('mongo.connection.string')() + "\n");
            process.exit(1);
        }
    });

    app.set('port', config.app.port);
    app.set('views', __dirname + '/views');
    app.set('view engine', 'ejs');

    // Check for request type, return 406 if content is not acceptable
    app.use(middlewares.setRequestType(app));

    // Set response appropriate content type
    app.use(middlewares.setContentType(app));

    // Formalize sort query parameter
    app.use(middlewares.formalizeSortParameter(app));

    // Formalize limit query parameter
    app.use(middlewares.formalizeLimitParameter(app));

    // Enable CORS request
    app.use(middlewares.enableCORS(app));

    // Set X-Geoname-* Response headers
    app.use(middlewares.setGeonamesResponseHeaders(app));

    app.use(express.urlencoded());
    app.use(express.json());
    app.use(methodOverride('X-HTTP-Method'));          // Microsoft
    app.use(methodOverride('X-HTTP-Method-Override')); // Google/GData, default option
    app.use(methodOverride('X-Method-Override'));      // IBM
    app.use(app.router);

    // Set root controller, template are in views directory
    app.get('/', function(req, res) {
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.render('index');
    });

    // Add city route
    require('./routes/city')(app);

    // Log errors
    app.use(function(err, req, res, next) {
        console.error(err.stack);
        next(err);
    });

    // Fallback to internal server error
    app.use(function(err, req, res, next) {
        res.status(500); return;
    });

    // Start app
    app.listen(app.get('port'), function(err) {
        if (err) { next(err); return; }
        console.log("Express server listening on port " + app.get('port'));
    });
});
