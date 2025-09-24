import pino from 'pino';
import config from 'config';

const level = config.has('logging.level') ? config.get<string>('logging.level') : 'info';
const name = config.has('app.name') ? config.get<string>('app.name') : 'Guardian';

const logger = pino({
  name,
  level
});

export default logger;
