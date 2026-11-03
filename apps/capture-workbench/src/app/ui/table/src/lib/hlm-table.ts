import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: 'div[hlmTableContainer]',
  host: {
    'data-slot': 'table-container',
  },
})
export class HlmTableContainer {
  constructor() {
    classes(() => 'relative w-full overflow-x-auto');
  }
}

@Directive({
  selector: 'table[hlmTable]',
  host: {
    'data-slot': 'table',
  },
})
export class HlmTable {
  constructor() {
    classes(() => 'w-full caption-bottom text-sm');
  }
}

@Directive({
  selector: 'thead[hlmTHead]',
  host: {
    'data-slot': 'table-header',
  },
})
export class HlmTHead {
  constructor() {
    classes(() => '[&_tr]:border-b');
  }
}

@Directive({
  selector: 'tbody[hlmTBody]',
  host: {
    'data-slot': 'table-body',
  },
})
export class HlmTBody {
  constructor() {
    classes(() => '[&_tr:last-child]:border-0');
  }
}

@Directive({
  selector: 'tfoot[hlmTFoot]',
  host: {
    'data-slot': 'table-footer',
  },
})
export class HlmTFoot {
  constructor() {
    classes(
      () => 'bg-muted/50 border-t font-medium [&>tr]:last:border-b-0',
    );
  }
}

@Directive({
  selector: 'tr[hlmTr]',
  host: {
    'data-slot': 'table-row',
  },
})
export class HlmTr {
  constructor() {
    classes(
      () =>
        'hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors',
    );
  }
}

@Directive({
  selector: 'th[hlmTh]',
  host: {
    'data-slot': 'table-head',
  },
})
export class HlmTh {
  constructor() {
    classes(
      () =>
        'text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0',
    );
  }
}

@Directive({
  selector: 'td[hlmTd]',
  host: {
    'data-slot': 'table-cell',
  },
})
export class HlmTd {
  constructor() {
    classes(
      () =>
        'p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0',
    );
  }
}

@Directive({
  selector: 'caption[hlmCaption]',
  host: {
    'data-slot': 'table-caption',
  },
})
export class HlmCaption {
  constructor() {
    classes(() => 'text-muted-foreground mt-4 text-sm');
  }
}
