namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.Prefabs;
    using Game.Routes;

    using Unity.Collections;
    using Unity.Entities;

    #endregion

    /// <summary>
    /// The vanilla line policies that set a <see cref="RouteOption"/> bit (Paid ticket, Day only,
    /// Night only, Inactive). Setting one goes through <c>PoliciesUISystem.SetPolicy</c>, never
    /// by writing <c>Route.m_OptionMask</c>, which the policy system rebuilds.
    /// </summary>
    public static class RoutePolicies {
        /// <summary>
        /// The policy prefab whose mask carries <paramref name="option"/>, or Null.
        /// <paramref name="policies"/> is a <c>WithAll&lt;PolicyData, RouteOptionData&gt;</c> query.
        /// </summary>
        public static Entity Find(EntityManager em, EntityQuery policies, RouteOption option) {
            var entities = policies.ToEntityArray(Allocator.Temp);
            var found    = Entity.Null;
            foreach (var policy in entities) {
                if (RouteUtils.HasOption(em.GetComponentData<RouteOptionData>(policy), option)) {
                    found = policy;
                    break;
                }
            }
            entities.Dispose();
            return found;
        }
    }
}
