// Where "/" sends a visitor: signed-in users go to the dashboard, everyone else sees the landing page.
export function homeTarget(user: object | null | undefined): "landing" | "/dashboard" {
  return user ? "/dashboard" : "landing";
}
