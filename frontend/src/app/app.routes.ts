import { type Routes } from '@angular/router';
import { settingsUnsavedChangesGuard } from './features/settings/settings-unsaved-changes.guard';
import { MainLayoutComponent } from './layouts/main-layout/main-layout.component';

/** Route table from 00 §12. The layout is eager; features are lazy. `**` stays inside the shell. */
export const routes: Routes = [
  {
    path: '',
    component: MainLayoutComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'repositories' },
      {
        path: 'repositories',
        title: 'Repositories',
        loadComponent: () =>
          import('./features/repositories/repository-list/repository-list.component').then(
            (m) => m.RepositoryListComponent,
          ),
      },
      {
        path: 'repositories/:id',
        title: 'Repository',
        loadComponent: () =>
          import('./features/repositories/repository-detail/repository-detail.component').then(
            (m) => m.RepositoryDetailComponent,
          ),
      },
      {
        path: 'visualizations',
        title: 'Visualizations',
        loadComponent: () =>
          import('./features/visualizations/visualization-list/visualization-list.component').then(
            (m) => m.VisualizationListComponent,
          ),
      },
      {
        path: 'visualizations/:id',
        title: 'Visualization',
        loadComponent: () =>
          import('./features/visualizations/visualization-detail/visualization-detail.component').then(
            (m) => m.VisualizationDetailComponent,
          ),
      },
      {
        path: 'library-jobs/:id',
        title: 'Library job',
        loadComponent: () =>
          import('./features/library-jobs/library-job-detail/library-job-detail.component').then(
            (m) => m.LibraryJobDetailComponent,
          ),
      },
      {
        path: 'settings',
        title: 'Settings',
        canDeactivate: [settingsUnsavedChangesGuard],
        loadComponent: () =>
          import('./features/settings/settings-page/settings-page.component').then((m) => m.SettingsPageComponent),
      },
      {
        path: '**',
        title: 'Not found',
        loadComponent: () =>
          import('./shared/components/not-found-page/not-found-page.component').then((m) => m.NotFoundPageComponent),
      },
    ],
  },
];
