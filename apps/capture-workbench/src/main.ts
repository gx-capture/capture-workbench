import { bootstrapApplication } from '@angular/platform-browser';
import { from } from 'rxjs';
import { appConfig } from './app/app.config';
import { App } from './app/app';

from(bootstrapApplication(App, appConfig)).subscribe({
  error: (err: unknown) => console.error(err),
});
