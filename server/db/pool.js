const { Pool } = require('pg');
const config = require('../config/env');

const pool = new Pool({ connectionString: config.databaseUrl });

module.exports = pool;
