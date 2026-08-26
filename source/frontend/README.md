# AWS Innovation Sandbox - User Interface (UI)

This project provides a User Interface (UI) to support the AWS Innovation Sandbox solution.

This project is a React project bootstrapped with [Vite](https://vite.dev).

---

## Getting started

1. Ensure that the [AWS Innovation Sandbox CDK](../infrastructure) project has been deployed to your AWS account.
2. Run `npm install` to install NPM packages
3. Configure the repo-root `.env` file with at minimum `DEPLOY_REGION` and `STACK_PREFIX` (defaults to `InnovationSandbox`). The dev server uses these to resolve the deployed CloudFront URL for API proxying. Alternatively, set `VITE_API_PROXY_TARGET` directly to skip the CloudFormation lookup. If using a named AWS profile for the hub account, set `HUB_ACCOUNT_PROFILE`.
4. Run `npm run dev` to run the UI locally

---

## Project Structure

#### Key Libraries

1. [React](https://react.dev) - React v18 framework

2. [Cloudscape Design Components](https://cloudscape.design) - An open source design system for cloud applications.

3. [AWS Northstar](https://aws.github.io/aws-northstar) - A library built on top of Cloudscape used for table components.

4. [AWS Amplify](https://docs.amplify.aws/javascript/) - Used as a Cognito SDK client for authentication token management and SigV4 request signing. The wider Amplify ecosystem including CLI and deployment mechanisms are **not** used in this project.

5. [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview) - For fetching, caching and synchronizing server state from the backend APIs.

6. [React Hook Form](https://react-hook-form.com) + [Zod](https://zod.dev) - Form state management and runtime validation.

#### Folder Structure

- `src/assets` - Static assets such as images

- `src/domains` - Each domain is split into its own sub folders with the following structure:
  - `pages` - Pages specific to that domain
  - `components` - Components specific to that domain (including `forms/` for form components)
  - `service.ts` - A class that performs API calls for that domain
  - `hooks.ts` - React hooks that wrap the above services using TanStack Query
  - `validation.ts` - Zod schemas for form validation
  - `types.ts` - Type definitions specific to that domain

- `src/components` - Common/shared components that are not domain specific

- `src/hooks` - Shared React hooks (breadcrumbs, app layout context, etc.)

- `src/helpers` - Helper or utility functions. Ideally these should be unit testable and not include React/JSX.

---

## Available Scripts

In the project directory, you can run:

#### Local development

```
npm run dev
```

The page will reload when you make changes.\
You may also see any lint errors in the console.

#### Build for deployment

```
npm run build
```

Builds the app for production to the `dist` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include hashes.
