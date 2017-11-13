const express = require('express');
const Router = require('express').Router;
const _ = require('lodash');
const request = require('superagent');
const binaryParser = require('superagent-binary-parser');
const csvParse = require( 'csv-parse' );
const through2 = require('through2');
const oboe = require('oboe');
const unzip = require('unzip');

const arcgisRegexp = /(Map|Feature)Server\/\d+\/?$/;

const determineType = (req, res, next) => {
  const source = req.query.source;

  if (arcgisRegexp.test(source)) {
    req.query.type = 'ESRI';
  } else if (_.endsWith(source, '.geojson')) {
    req.query.type = 'geojson';
  } else if (_.endsWith(source, '.geojson.zip')) {
    req.query.type = 'geojson';
    req.query.compression = 'zip';
  } else if (_.endsWith(source, '.csv')) {
    req.query.type = 'csv';
  } else if (_.endsWith(source, '.csv.zip')) {
    req.query.type = 'csv';
    req.query.compression = 'zip';
  } else {
    req.query.type = 'unknown';
  }

  next();

};

const typecheck = (type, compression) => (req, res, next) => {
  if (req.query.type === type && req.query.compression === compression) {
    next();
  } else {
    next('route');
  }

};

const lookupArcgisFields = (req, res, next) => {
  request
    .get(req.query.source)
    .accept('json')
    .query({ f: 'json' })
    .on('error', (err) => {
      console.error(err);
      return next();
    })
    .end((err, response) => {
      // bail early if there's an error (shouldn't happen since it was already handled above)
      if (err) {
        return next();
      }

      req.query.fields = JSON.parse(response.text).fields.map(_.property('name'));
      return next();

    });

};

const lookupArcgisSampleRecords = (req, res, next) => {
  request
    .get(`${req.query.source}/query`)
    .accept('json')
    .query({
      outFields: '*',
      where: '1=1',
      resultRecordCount: 10,
      resultOffset: 0,
      f: 'json'
    })
    .on('error', (err) => {
      // console.error(err);
      return next();
    })
    .end((err, response) => {
      // bail early if there's an error (shouldn't happen since it was already handled above)
      if (err) {
        return next();
      }

      req.query.results = JSON.parse(response.text).features.map( _.property('attributes') );
      return next();

    });

};

const processGeojson = (req, res, next) => {
  console.log(`requesting ${req.query.source}`);

  req.query.results = [];

  oboe(req.query.source)
    .node('features[*]', function(feature) {
      req.query.fields = _.keys(feature.properties);
      req.query.results.push(feature.properties);
    })
    .node('features[9]', function() {
      // bail after the 10th result.  'done' does not get called after .abort()
      //  so next() must be called explicitly
      this.abort();
      next();
    })
    .done(() => {
      next();
    });

};

const processGeojsonZip = (req, res, next) => {
  console.log(`requesting ${req.query.source}`);

  request
    .get(req.query.source)
    .pipe(unzip.Parse())
    .on('entry', entry => {
      req.query.results = [];

      oboe(entry)
        .node('features[*]', function(feature) {
          req.query.fields = _.keys(feature.properties);
          req.query.results.push(feature.properties);
        })
        .node('features[9]', function() {
          // bail after the 10th result.  'done' does not get called after .abort()
          //  so next() must be called explicitly
          this.abort();
          next();
        })
        .done(() => {
          next();
        });

    });

};

const processCsv = (req, res, next) => {
  console.log(`requesting ${req.query.source}`);

  req.query.results = [];

  request.get(req.query.source).pipe(csvParse({
    skip_empty_lines: true,
    columns: true
  }))
  .pipe(through2.obj(function(record, enc, callback) {
    if (req.query.results.length < 10) {
      req.query.fields = _.keys(record);
      req.query.results.push(record);
      callback();
    } else {
      // there are enough records so end the stream prematurely, handle in 'close' event
      this.destroy();
    }

  }))
  .on('close', () => {
    // stream was closed prematurely
    next();
  })
  .on('finish', () => {
    // stream was ended normally
    next();
  });

};

const processCsvZip = (req, res, next) => {
  console.log(`requesting ${req.query.source}`);

  req.query.results = [];

  request.get(req.query.source)
  .pipe(unzip.Parse())
  .on('entry', entry => {
    entry.pipe(csvParse({
      skip_empty_lines: true,
      columns: true
    }))
    .pipe(through2.obj(function(record, enc, callback) {
      if (req.query.results.length < 10) {
        req.query.fields = _.keys(record);
        req.query.results.push(record);
        callback();
      } else {
        // there are enough records so end the stream prematurely, handle in 'close' event
        this.destroy();
      }

    }))
    .on('close', () => {
      // stream was closed prematurely
      next();
    })
    .on('finish', () => {
      // stream was ended normally
      next();
    });

  });

};

const output = (req, res, next) => {
  res.status(200).send({
    type: req.query.type,
    compression: req.query.compression,
    fields: req.query.fields,
    results: req.query.results
  });
  next();
};

module.exports = () => {
  const app = express();

  const arcgisRouter = express.Router();
  arcgisRouter.get('/fields', typecheck('ESRI'), lookupArcgisFields, lookupArcgisSampleRecords);

  const geojsonRouter = express.Router();
  geojsonRouter.get('/fields', typecheck('geojson'), processGeojson);

  const geojsonZipRouter = express.Router();
  geojsonRouter.get('/fields', typecheck('geojson', 'zip'), processGeojsonZip);

  const csvRouter = express.Router();
  csvRouter.get('/fields', typecheck('csv'), processCsv);

  const csvZipRouter = express.Router();
  csvRouter.get('/fields', typecheck('csv', 'zip'), processCsvZip);

  app.get('/fields',
    determineType,
    arcgisRouter,
    geojsonRouter,
    geojsonZipRouter,
    csvRouter,
    csvZipRouter,
    output
  );

  app.use(express.static(__dirname + '/public'));

  return app;

};
